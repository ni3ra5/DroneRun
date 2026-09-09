import * as THREE from 'three';

/**
 * Sky, ground, lighting and starfield, in two lighting presets.
 *
 * Everything a theme touches is declared in THEMES below, and `setTheme`
 * mutates the existing objects rather than rebuilding the scene — so the
 * player can flip between day and night without a reload or a hitch.
 *
 * The ground grids are built by hand instead of with THREE.GridHelper: the
 * helper bakes its two line colours into a vertex-colour attribute, which
 * would mean rebuilding geometry on every theme change. A single-colour
 * LineSegments per grid makes recolouring a one-line material update.
 */

export const THEMES = {
  night: {
    sky: { top: 0x05070f, horizon: 0x1d3a5c, bottom: 0x04060b },
    fog: { color: 0x0a1220, density: 0.0034 },
    hemi: { sky: 0x4a6fa5, ground: 0x0f1622, intensity: 0.55 },
    ambient: { color: 0x2c3c58, intensity: 0.3 },
    sun: { color: 0xc8daff, intensity: 1.6, offset: [-90, 130, 70] },
    rim: { color: 0x6f9bd8, intensity: 0.4 },
    ground: 0x121b2b,
    gridFine: { color: 0x1d3550, opacity: 0.42 },
    gridCoarse: { color: 0x2f5f80, opacity: 0.28 },
    stars: true,
    exposure: 1.0,
    // Only the drone shells reach the bloom pass, so there is no threshold
    // to tune — the isolation is by layer. See Game._buildComposer.
    bloom: { strength: 1.15, radius: 0.55 },
  },
  day: {
    sky: { top: 0x2f7fd0, horizon: 0xbcd7ef, bottom: 0x9fb8cc },
    // Fog matches the horizon so distant towers dissolve into haze.
    fog: { color: 0xbcd7ef, density: 0.0026 },
    hemi: { sky: 0xcfe3fa, ground: 0x6e7a88, intensity: 0.6 },
    ambient: { color: 0xb9cfe6, intensity: 0.35 },
    // Oblique rather than overhead: a near-vertical sun leaves every
    // building's vertical faces unlit and flattens the whole skyline.
    sun: { color: 0xfff4e2, intensity: 2.1, offset: [-120, 150, 95] },
    rim: { color: 0xbcd3f0, intensity: 0.25 },
    ground: 0x7e8a95,
    gridFine: { color: 0x5f6f7d, opacity: 0.3 },
    gridCoarse: { color: 0x49596a, opacity: 0.3 },
    stars: false,
    exposure: 0.95,
    // Daylight needs a firmer glow to read against a bright sky.
    bloom: { strength: 1.35, radius: 0.5 },
  },
};

const SKY_VERT = /* glsl */`
  varying vec3 vPos;
  void main() {
    vPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = /* glsl */`
  varying vec3 vPos;
  uniform vec3 top;
  uniform vec3 horizon;
  uniform vec3 bottom;
  void main() {
    float h = normalize(vPos).y;
    vec3 c = h > 0.0
      ? mix(horizon, top, pow(clamp(h, 0.0, 1.0), 0.62))
      : mix(horizon, bottom, pow(clamp(-h, 0.0, 1.0), 0.5));
    gl_FragColor = vec4(c, 1.0);
  }
`;

/** Flat grid of lines on the XZ plane, one uniform colour. */
function makeGrid(size, divisions, color, opacity) {
  const half = size / 2;
  const step = size / divisions;
  const pts = [];
  for (let i = 0; i <= divisions; i++) {
    const p = -half + i * step;
    pts.push(-half, 0, p, half, 0, p);
    pts.push(p, 0, -half, p, 0, half);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
    color, transparent: true, opacity, depthWrite: false,
  }));
}

export class Environment {
  constructor(scene, renderer, theme = 'night') {
    this.scene = scene;
    this.renderer = renderer;
    this.shadowRange = 68;
    this.sunOffset = new THREE.Vector3();

    scene.fog = new THREE.FogExp2(0x000000, 0.003);

    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(1400, 32, 20),
      new THREE.ShaderMaterial({
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        uniforms: {
          top: { value: new THREE.Color() },
          horizon: { value: new THREE.Color() },
          bottom: { value: new THREE.Color() },
        },
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    );
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
    scene.add(this.hemi);

    this.ambient = new THREE.AmbientLight(0xffffff, 1);
    scene.add(this.ambient);

    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.035;
    const sc = this.sun.shadow.camera;
    sc.near = 1;
    sc.far = 460;
    sc.left = -this.shadowRange;
    sc.right = this.shadowRange;
    sc.top = this.shadowRange;
    sc.bottom = -this.shadowRange;
    sc.updateProjectionMatrix();
    scene.add(this.sun);
    scene.add(this.sun.target);

    // A cool rim light from the opposite side keeps silhouettes readable.
    this.rim = new THREE.DirectionalLight(0xffffff, 1);
    this.rim.position.set(80, 40, -110);
    scene.add(this.rim);

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(2600, 2600),
      new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0.05 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.02;
    this.ground.receiveShadow = true;
    scene.add(this.ground);

    // The fine grid is kept short: extended further it is viewed at grazing
    // angles from altitude and turns into a moiré haze.
    this.gridFine = makeGrid(760, 152, 0xffffff, 1);
    this.gridFine.position.y = 0.02;
    scene.add(this.gridFine);

    this.gridCoarse = makeGrid(2400, 30, 0xffffff, 1);
    this.gridCoarse.position.y = 0.04;
    scene.add(this.gridCoarse);

    this._buildStars();
    this.setTheme(theme);
  }

  _buildStars() {
    const count = 1400;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // Upper hemisphere only, biased away from the horizon haze.
      const theta = Math.random() * Math.PI * 2;
      const y = 0.18 + Math.random() * 0.82;
      const r = Math.sqrt(1 - y * y);
      const d = 1100;
      pos[i * 3] = Math.cos(theta) * r * d;
      pos[i * 3 + 1] = y * d;
      pos[i * 3 + 2] = Math.sin(theta) * r * d;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0x9fc4ff, size: 2.6, sizeAttenuation: false,
      transparent: true, opacity: 0.7, depthWrite: false, fog: false,
    }));
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);
  }

  /** @param {'day'|'night'} name */
  setTheme(name) {
    const t = THEMES[name] ?? THEMES.night;
    this.theme = THEMES[name] ? name : 'night';

    const u = this.sky.material.uniforms;
    u.top.value.setHex(t.sky.top);
    u.horizon.value.setHex(t.sky.horizon);
    u.bottom.value.setHex(t.sky.bottom);

    this.scene.fog.color.setHex(t.fog.color);
    this.scene.fog.density = t.fog.density;

    this.hemi.color.setHex(t.hemi.sky);
    this.hemi.groundColor.setHex(t.hemi.ground);
    this.hemi.intensity = t.hemi.intensity;

    this.ambient.color.setHex(t.ambient.color);
    this.ambient.intensity = t.ambient.intensity;

    this.sun.color.setHex(t.sun.color);
    this.sun.intensity = t.sun.intensity;
    this.sunOffset.fromArray(t.sun.offset);

    this.rim.color.setHex(t.rim.color);
    this.rim.intensity = t.rim.intensity;

    this.ground.material.color.setHex(t.ground);

    this.gridFine.material.color.setHex(t.gridFine.color);
    this.gridFine.material.opacity = t.gridFine.opacity;
    this.gridCoarse.material.color.setHex(t.gridCoarse.color);
    this.gridCoarse.material.opacity = t.gridCoarse.opacity;

    this.stars.visible = t.stars;
    if (this.renderer) this.renderer.toneMappingExposure = t.exposure;
    this.bloom = t.bloom;
  }

  /** Keep the shadow frustum centred on the action. */
  update(focus) {
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).add(this.sunOffset);
  }
}
