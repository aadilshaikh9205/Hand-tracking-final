
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

// --- Noise Utility ---
class Noise3D {
  p = new Uint8Array(512);
  constructor() {
    const v = new Uint8Array(256);
    for (let i = 0; i < 256; i++) v[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [v[i], v[j]] = [v[j], v[i]];
    }
    this.p.set(v);
    this.p.set(v, 256);
  }
  fade(t: number) { return t * t * t * (t * (t * 6 - 15) + 10); }
  lerp(t: number, a: number, b: number) { return a + t * (b - a); }
  grad(hash: number, x: number, y: number, z: number) {
    const h = hash & 15;
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  }
  get(x: number, y: number, z: number) {
    const xi = Math.floor(x) & 255, yi = Math.floor(y) & 255, zi = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    const u = this.fade(x), v = this.fade(y), w = this.fade(z);
    const a = this.p[xi] + yi, aa = this.p[a] + zi, ab = this.p[a + 1] + zi;
    const b = this.p[xi + 1] + yi, ba = this.p[b] + zi, bb = this.p[b + 1] + zi;
    return this.lerp(w, this.lerp(v, this.lerp(u, this.grad(this.p[aa], x, y, z), this.grad(this.p[ba], x - 1, y, z)),
      this.lerp(u, this.grad(this.p[ab], x, y - 1, z), this.grad(this.p[bb], x - 1, y - 1, z))),
      this.lerp(v, this.lerp(u, this.grad(this.p[aa + 1], x, y, z - 1), this.grad(this.p[ba + 1], x - 1, y, z - 1)),
        this.lerp(u, this.grad(this.p[ab + 1], x, y - 1, z - 1), this.grad(this.p[bb + 1], x - 1, y - 1, z - 1))));
  }
}

// --- Constants & Types ---
const PARTICLE_COUNT = 20000;
const STORAGE_KEY = 'aether_vision_config';
const CUSTOM_PALETTES_KEY = 'aether_custom_palettes';

type Template = 'HEART' | 'FLOWER' | 'SATURN' | 'FIREWORKS' | 'SPHERE' | 'GALAXY' | 'NEBULA' | 'AADIL';
const ALL_TEMPLATES: Template[] = ['SPHERE', 'HEART', 'GALAXY', 'NEBULA', 'FLOWER', 'SATURN', 'FIREWORKS', 'AADIL'];

interface ColorPalette {
  name: string;
  colorA: string;
  colorB: string;
}

const BASE_PALETTES: ColorPalette[] = [
  { name: 'Aether', colorA: '#00f2ff', colorB: '#ff00ff' },
  { name: 'Inferno', colorA: '#ff4e00', colorB: '#fff000' },
  { name: 'Borealis', colorA: '#00ff87', colorB: '#60efff' },
  { name: 'Cyber', colorA: '#7000ff', colorB: '#00ffcc' },
  { name: 'GoldRush', colorA: '#ffd700', colorB: '#ffffff' },
  { name: 'Valentine', colorA: '#ff0044', colorB: '#ff88cc' },
  { name: 'Aadil', colorA: '#FFD700', colorB: '#FFFFFF' }
];

let activePalettes: ColorPalette[] = [...BASE_PALETTES];

interface ParticleState {
  template: Template;
  expansion: number;
  attractionPoint: THREE.Vector3;
  attractionStrength: number;
  paletteIndex: number;
  nextPaletteIndex: number;
  paletteTransition: number;
  baseParticleSize: number;
  lifespanSpeed: number;
  bloomIntensity: number;
}

// --- Audio Engine ---
class AetherAudio {
  ctx: AudioContext | null = null;
  masterGain: GainNode | null = null;
  ambientOsc: OscillatorNode | null = null;
  ambientGain: GainNode | null = null;
  filter: BiquadFilterNode | null = null;

  init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.setValueAtTime(0.15, this.ctx.currentTime);
    this.masterGain.connect(this.ctx.destination);

    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.setValueAtTime(800, this.ctx.currentTime);
    this.filter.Q.setValueAtTime(2, this.ctx.currentTime);
    this.filter.connect(this.masterGain);

    this.ambientOsc = this.ctx.createOscillator();
    this.ambientOsc.type = 'sine';
    this.ambientOsc.frequency.setValueAtTime(60, this.ctx.currentTime);
    
    this.ambientGain = this.ctx.createGain();
    this.ambientGain.gain.setValueAtTime(0.3, this.ctx.currentTime);
    
    this.ambientOsc.connect(this.ambientGain);
    this.ambientGain.connect(this.filter);
    this.ambientOsc.start();
  }

  update(expansion: number, attractionStrength: number) {
    if (!this.ctx || !this.ambientOsc || !this.filter) return;
    const now = this.ctx.currentTime;
    const baseFreq = 40 + expansion * 20;
    this.ambientOsc.frequency.setTargetAtTime(baseFreq, now, 0.1);
    const filterFreq = 400 + (attractionStrength * 8000) + (expansion * 200);
    this.filter.frequency.setTargetAtTime(Math.min(filterFreq, 12000), now, 0.2);
  }

  playMorph() {
    if (!this.ctx || !this.filter) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(200, now);
    osc.frequency.exponentialRampToValueAtTime(800, now + 0.3);
    osc.frequency.exponentialRampToValueAtTime(100, now + 0.8);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.4, now + 0.1);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.8);
    osc.connect(g);
    g.connect(this.filter);
    osc.start();
    osc.stop(now + 0.8);
  }

  playValentineChime() {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.50];
    notes.forEach((freq, i) => {
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + i * 0.05);
      g.gain.setValueAtTime(0, now + i * 0.05);
      g.gain.linearRampToValueAtTime(0.2, now + i * 0.05 + 0.1);
      g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.05 + 2);
      osc.connect(g);
      g.connect(this.masterGain!);
      osc.start(now + i * 0.05);
      osc.stop(now + i * 0.05 + 2);
    });
  }
}

// --- Particle Engine ---
class ParticleEngine {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  bloomPass: UnrealBloomPass;
  points: THREE.Points;
  geometry: THREE.BufferGeometry;
  audio: AetherAudio;
  noiseField: Noise3D;
  
  positions: Float32Array;
  targetPositions: Float32Array;
  velocities: Float32Array;
  colors: Float32Array;
  sizes: Float32Array;
  lifespanValues: Float32Array;
  decayRates: Float32Array;
  
  state: ParticleState = {
    template: 'SPHERE',
    expansion: 1.0,
    attractionPoint: new THREE.Vector3(0, 0, 0),
    attractionStrength: 0.0,
    paletteIndex: 0,
    nextPaletteIndex: 0,
    paletteTransition: 1.0,
    baseParticleSize: 0.08,
    lifespanSpeed: 1.0,
    bloomIntensity: 1.5
  };

  // Pre-sampled text coordinates for "Aadil"
  textCoords: {x: number, y: number}[] = [];

  constructor(audio: AetherAudio) {
    this.audio = audio;
    this.noiseField = new Noise3D();
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.renderer = new THREE.WebGLRenderer({ 
        canvas: document.getElementById('three-canvas') as HTMLCanvasElement,
        antialias: false,
        alpha: true
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ReinhardToneMapping;

    this.composer = new EffectComposer(this.renderer);
    const renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(renderPass);

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      this.state.bloomIntensity,
      0.4,
      0.1
    );
    this.composer.addPass(this.bloomPass);

    this.positions = new Float32Array(PARTICLE_COUNT * 3);
    this.targetPositions = new Float32Array(PARTICLE_COUNT * 3);
    this.velocities = new Float32Array(PARTICLE_COUNT * 3);
    this.colors = new Float32Array(PARTICLE_COUNT * 3);
    this.sizes = new Float32Array(PARTICLE_COUNT);
    this.lifespanValues = new Float32Array(PARTICLE_COUNT);
    this.decayRates = new Float32Array(PARTICLE_COUNT);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
        this.sizes[i] = this.state.baseParticleSize * (0.8 + Math.random() * 0.4);
        this.lifespanValues[i] = Math.random();
        const individualLifespan = 0.5 + Math.random() * 1.5;
        this.decayRates[i] = 0.008 / individualLifespan; 
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));
    this.geometry.setAttribute('life', new THREE.BufferAttribute(this.lifespanValues, 1));

    const shaderMaterial = new THREE.ShaderMaterial({
      vertexShader: `
        attribute float size;
        attribute float life;
        attribute vec3 color;
        varying vec3 vColor;
        varying float vLife;
        void main() {
          vColor = color;
          vLife = life;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * (400.0 / -mvPosition.z);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vLife;
        void main() {
          float dist = distance(gl_PointCoord, vec2(0.5));
          if (dist > 0.5) discard;
          float alpha = 1.0 - smoothstep(0.4, 0.5, dist);
          float sparkle = smoothstep(0.0, 0.2, vLife) * smoothstep(1.0, 0.8, vLife);
          gl_FragColor = vec4(vColor, alpha * 0.8 * sparkle);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    this.points = new THREE.Points(this.geometry, shaderMaterial);
    this.scene.add(this.points);
    this.camera.position.z = 40;

    // Prepare text sampling for "Aadil"
    this.prepareTextSampling("Aadil");

    this.setTemplate('SPHERE');
    this.animate();
    this.startPaletteCycle();
    
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.composer.setSize(window.innerWidth, window.innerHeight);
      this.bloomPass.resolution.set(window.innerWidth, window.innerHeight);
    });
  }

  prepareTextSampling(text: string) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // Adjusted sampling canvas size for better mobile proportions
    canvas.width = 800;
    canvas.height = 400;
    
    ctx.fillStyle = 'white';
    // Using a font size that leaves room for the display edges
    ctx.font = 'bold 200px "Inter", "Arial", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;
    const step = 2;
    
    this.textCoords = [];
    for (let y = 0; y < canvas.height; y += step) {
      for (let x = 0; x < canvas.width; x += step) {
        const index = (y * canvas.width + x) * 4;
        if (pixels[index] > 128) {
          // Scaling down the normalization factor from 0.12 to 0.05 
          // to make the structure "normal" size for mobile displays
          this.textCoords.push({
            x: (x - canvas.width / 2) * 0.055, 
            y: (canvas.height / 2 - y) * 0.055
          });
        }
      }
    }
  }

  startPaletteCycle() {
    setInterval(() => {
      if (this.state.template === 'HEART' && this.state.nextPaletteIndex === 5) return;
      if (this.state.template === 'AADIL' && this.state.nextPaletteIndex === 6) return;
      const status = document.getElementById('status')?.textContent;
      if (status && status.includes("Watching")) {
        this.state.nextPaletteIndex = (this.state.paletteIndex + 1) % activePalettes.length;
        this.state.paletteTransition = 0;
        this.updateThemeLabel();
      }
    }, 12000);
  }

  forcePalette(index: number) {
    if (index >= activePalettes.length) index = 0;
    this.state.nextPaletteIndex = index;
    this.state.paletteTransition = 0;
    this.updateThemeLabel();
    if (index === 5) this.audio.playValentineChime();
    
    document.querySelectorAll('.texture-btn').forEach((btn, i) => {
        if (i === index) btn.classList.add('active');
        else btn.classList.remove('active');
    });
  }

  updateThemeLabel() {
    const themeLabel = document.getElementById('theme-label');
    if (themeLabel) themeLabel.textContent = `Theme: ${activePalettes[this.state.nextPaletteIndex].name}`;
  }

  setParticleSize(baseSize: number) {
    this.state.baseParticleSize = baseSize;
    const sizeAttr = this.geometry.attributes.size.array as Float32Array;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
        sizeAttr[i] = baseSize * (0.8 + Math.random() * 0.4);
    }
    this.geometry.attributes.size.needsUpdate = true;
  }

  setBloomIntensity(intensity: number) {
    this.state.bloomIntensity = intensity;
    this.bloomPass.strength = intensity;
  }

  setLifespanSpeed(speed: number) {
    this.state.lifespanSpeed = speed;
  }

  setTemplate(type: Template) {
    if (this.state.template === type) return;
    this.state.template = type;
    this.audio.playMorph();

    const tempPositions = new Float32Array(PARTICLE_COUNT * 3);
    
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const idx = i * 3;
      let x = 0, y = 0, z = 0;

      switch(type) {
        case 'AADIL': {
          if (this.textCoords.length > 0) {
            const coord = this.textCoords[i % this.textCoords.length];
            x = coord.x;
            y = coord.y;
            z = (Math.random() - 0.5) * 2; // Reduced 3D depth for a cleaner mobile look
          } else {
            const t = Math.random();
            const theta = Math.random() * Math.PI * 2;
            const xPos = (t - 0.5) * 30;
            const yWave = Math.sin(t * Math.PI * 4) * 3;
            const radius = 1 + Math.random() * 2;
            x = xPos; y = yWave + Math.cos(theta) * radius; z = Math.sin(theta) * radius;
          }
          break;
        }
        case 'HEART': {
          const t = Math.random() * Math.PI * 2;
          const u = (Math.random() - 0.5) * 2.0;
          const h_x = 16 * Math.pow(Math.sin(t), 3);
          const h_y = 15 * Math.cos(t) - 8 * Math.cos(2 * t) - 2.5 * Math.cos(3 * t) - Math.cos(4 * t);
          const volume = Math.pow(Math.cos(u * Math.PI * 0.5), 0.5); 
          x = h_x * volume; y = h_y * volume; z = u * 12 * volume; 
          x *= 0.85; y *= 0.85; y += 3.0;
          break;
        }
        case 'FLOWER': {
          const f_angle = Math.random() * Math.PI * 2;
          const k = 6; 
          const r = 18 * Math.cos(k * f_angle);
          x = r * Math.cos(f_angle); y = r * Math.sin(f_angle); z = (Math.random() - 0.5) * 6;
          break;
        }
        case 'SATURN': {
          if (i < PARTICLE_COUNT * 0.4) {
            const s_radius = 8 * Math.pow(Math.random(), 0.5);
            const su = Math.random() * Math.PI * 2;
            const sv = Math.acos(2 * Math.random() - 1);
            x = s_radius * Math.sin(sv) * Math.cos(su); y = s_radius * Math.sin(sv) * Math.sin(su); z = s_radius * Math.cos(sv);
          } else {
            const inner = 12; const outer = 22;
            const radius = inner + Math.random() * (outer - inner);
            const theta = Math.random() * Math.PI * 2;
            x = radius * Math.cos(theta); z = radius * Math.sin(theta); y = (Math.random() - 0.5) * 0.8;
            const tempY = y * Math.cos(0.5) - z * Math.sin(0.5);
            const tempZ = y * Math.sin(0.5) + z * Math.cos(0.5);
            y = tempY; z = tempZ;
          }
          break;
        }
        case 'FIREWORKS': {
          const fireRadius = 10 + Math.random() * 25;
          const fTheta = Math.random() * Math.PI * 2;
          const fPhi = Math.acos(2 * Math.random() - 1);
          x = fireRadius * Math.sin(fPhi) * Math.cos(fTheta); y = fireRadius * Math.sin(fPhi) * Math.sin(fTheta); z = fireRadius * Math.cos(fPhi);
          break;
        }
        case 'GALAXY': {
          const arm = i % 2 === 0 ? 0 : Math.PI;
          const r_gal = Math.random() * 25;
          const theta_gal = r_gal * 0.4 + arm + (Math.random() - 0.5) * 0.8;
          x = r_gal * Math.cos(theta_gal); y = r_gal * Math.sin(theta_gal); z = (Math.random() - 0.5) * (15 / (r_gal + 1));
          break;
        }
        case 'NEBULA': {
          const u_neb = Math.random() * Math.PI * 2;
          const v_neb = Math.random() * Math.PI - Math.PI/2;
          const r_neb = 18 * (Math.random() + 0.1);
          const pinch = 0.15 + Math.pow(Math.abs(Math.sin(v_neb)), 2);
          x = r_neb * pinch * Math.cos(v_neb) * Math.cos(u_neb); y = r_neb * pinch * Math.sin(v_neb); z = r_neb * pinch * Math.cos(v_neb) * Math.sin(u_neb);
          break;
        }
        default: { // SPHERE
          const s_su = Math.random() * Math.PI * 2;
          const s_sv = Math.acos(2 * Math.random() - 1);
          const sradius = 15;
          x = sradius * Math.sin(s_sv) * Math.cos(s_su); y = sradius * Math.sin(s_sv) * Math.sin(s_su); z = sradius * Math.cos(s_sv);
        }
      }
      tempPositions[idx] = x;
      tempPositions[idx+1] = y;
      tempPositions[idx+2] = z;
    }
    this.targetPositions.set(tempPositions);

    document.querySelectorAll('.struct-btn').forEach(btn => {
        if (btn.textContent === type) btn.classList.add('active');
        else btn.classList.remove('active');
    });

    if (type === 'AADIL') {
      this.forcePalette(6);
    }
  }

  updatePhysics(expansion: number, attractX: number, attractY: number, attractActive: boolean) {
    this.state.expansion = expansion;
    this.state.attractionPoint.set(attractX, attractY, 0);
    this.state.attractionStrength = attractActive ? 0.08 : 0.0;
    this.audio.update(this.state.expansion, this.state.attractionStrength);
  }

  saveConfig() {
    const config = { 
      template: this.state.template, 
      paletteIndex: this.state.paletteIndex,
      particleSize: this.state.baseParticleSize,
      lifespanSpeed: this.state.lifespanSpeed,
      bloomIntensity: this.state.bloomIntensity
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    return config;
  }

  loadConfig() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return null;
    try {
      const config = JSON.parse(saved);
      this.setTemplate(config.template);
      this.state.paletteIndex = config.paletteIndex;
      this.state.nextPaletteIndex = config.paletteIndex;
      this.state.paletteTransition = 1.0;
      if (config.particleSize) {
          this.setParticleSize(config.particleSize);
          const slider = document.getElementById('size-slider') as HTMLInputElement;
          if (slider) slider.value = config.particleSize.toString();
      }
      if (config.lifespanSpeed !== undefined) {
          this.setLifespanSpeed(config.lifespanSpeed);
          const slider = document.getElementById('lifespan-slider') as HTMLInputElement;
          if (slider) slider.value = config.lifespanSpeed.toString();
      }
      if (config.bloomIntensity !== undefined) {
          this.setBloomIntensity(config.bloomIntensity);
          const slider = document.getElementById('bloom-slider') as HTMLInputElement;
          if (slider) slider.value = config.bloomIntensity.toString();
      }
      this.updateThemeLabel();
      return config;
    } catch (e) {
      return null;
    }
  }

  animate = () => {
    requestAnimationFrame(this.animate);
    const pos = this.geometry.attributes.position.array as Float32Array;
    const target = this.targetPositions;
    const vel = this.velocities;
    const lifeAttr = this.geometry.attributes.life.array as Float32Array;
    const { expansion, attractionPoint, attractionStrength, paletteIndex, nextPaletteIndex, paletteTransition, lifespanSpeed, template } = this.state;
    const time = performance.now() * 0.001;

    if (this.state.paletteTransition < 1.0) {
      this.state.paletteTransition += 0.005;
      if (this.state.paletteTransition >= 1.0) this.state.paletteIndex = this.state.nextPaletteIndex;
    }

    const currPal = activePalettes[paletteIndex] || activePalettes[0];
    const nextPal = activePalettes[nextPaletteIndex] || activePalettes[0];
    const baseA = new THREE.Color(currPal.colorA).lerp(new THREE.Color(nextPal.colorA), paletteTransition);
    const baseB = new THREE.Color(currPal.colorB).lerp(new THREE.Color(nextPal.colorB), paletteTransition);
    const lerpFactor = Math.min(Math.max((expansion - 0.8) / 1.5, 0), 1);
    const lerpedColor = baseA.clone().lerp(baseB, lerpFactor);
    const colorAttr = this.geometry.attributes.color.array as Float32Array;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
        colorAttr[i*3] = lerpedColor.r; colorAttr[i*3+1] = lerpedColor.g; colorAttr[i*3+2] = lerpedColor.b;
    }
    this.geometry.attributes.color.needsUpdate = true;

    const windX = Math.sin(time * 0.4) * 0.015;
    const windY = Math.cos(time * 0.2) * 0.01;
    const windZ = Math.sin(time * 0.3) * 0.005;

    const noiseScale = 0.05;
    const noiseAmp = 0.015;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const ix = i * 3; const iy = i * 3 + 1; const iz = i * 3 + 2;
      
      lifeAttr[i] -= this.decayRates[i] * lifespanSpeed;
      if (lifeAttr[i] <= 0) {
          lifeAttr[i] = 1.0;
          pos[ix] = target[ix] * expansion + (Math.random() - 0.5) * (template === 'AADIL' ? 0.2 : 5);
          pos[iy] = target[iy] * expansion + (Math.random() - 0.5) * (template === 'AADIL' ? 0.2 : 5);
          pos[iz] = target[iz] * expansion + (Math.random() - 0.5) * (template === 'AADIL' ? 0.2 : 5);
          vel[ix] = 0; vel[iy] = 0; vel[iz] = 0;
      }

      const spring = template === 'AADIL' ? 0.15 : 0.01;
      const ax = (target[ix] * expansion - pos[ix]) * spring;
      const ay = (target[iy] * expansion - pos[iy]) * spring;
      const az = (target[iz] * expansion - pos[iz]) * spring;

      let attrX = 0, attrY = 0;
      if (attractionStrength > 0) {
        attrX = (attractionPoint.x - pos[ix]) * attractionStrength;
        attrY = (attractionPoint.y - pos[iy]) * attractionStrength;
      }

      const nx = this.noiseField.get(pos[ix] * noiseScale, pos[iy] * noiseScale, pos[iz] * noiseScale + time * 0.5) * noiseAmp;
      const ny = this.noiseField.get(pos[iy] * noiseScale, pos[iz] * noiseScale, pos[ix] * noiseScale + time * 0.5) * noiseAmp;
      const nz = this.noiseField.get(pos[iz] * noiseScale, pos[ix] * noiseScale, pos[iy] * noiseScale + time * 0.5) * noiseAmp;

      vel[ix] += ax + attrX + windX + nx;
      vel[iy] += ay + attrY + windY + ny;
      vel[iz] += az + windZ + nz;
      
      const damping = template === 'AADIL' ? 0.8 : 0.94;
      vel[ix] *= damping; vel[iy] *= damping; vel[iz] *= damping;
      pos[ix] += vel[ix]; pos[iy] += vel[iy]; pos[iz] += vel[iz];
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.life.needsUpdate = true;
    this.points.rotation.y += template === 'AADIL' ? 0 : 0.001; 
    this.composer.render();
  }
}

// --- Interaction Manager ---
async function setupApp() {
  const audio = new AetherAudio();
  const engine = new ParticleEngine(audio);
  const statusEl = document.getElementById('status')!;
  const videoElement = document.getElementById('video-feed') as HTMLVideoElement;
  const canvasElement = document.getElementById('gesture-canvas') as HTMLCanvasElement;
  const ctx = canvasElement.getContext('2d')!;
  const overlay = document.getElementById('permission-overlay')!;
  const startBtn = document.getElementById('start-btn') as HTMLButtonElement;
  const hintEl = document.getElementById('instruction-hint')!;
  
  const saveBtn = document.getElementById('save-btn') as HTMLButtonElement;
  const loadBtn = document.getElementById('load-btn') as HTMLButtonElement;
  const clearPalettesBtn = document.getElementById('clear-palettes-btn') as HTMLButtonElement;
  const addPaletteBtn = document.getElementById('add-palette-btn') as HTMLButtonElement;
  const hexAInput = document.getElementById('hex-a') as HTMLInputElement;
  const hexBInput = document.getElementById('hex-b') as HTMLInputElement;
  const sizeSlider = document.getElementById('size-slider') as HTMLInputElement;
  const lifespanSlider = document.getElementById('lifespan-slider') as HTMLInputElement;
  const bloomSlider = document.getElementById('bloom-slider') as HTMLInputElement;
  
  const structGrid = document.getElementById('structure-grid')!;
  const textureGrid = document.getElementById('texture-grid')!;

  ALL_TEMPLATES.forEach(temp => {
      const btn = document.createElement('button');
      btn.className = 'grid-btn struct-btn';
      btn.textContent = temp;
      btn.onclick = () => engine.setTemplate(temp);
      structGrid.appendChild(btn);
  });

  const updateTextureButtons = () => {
    textureGrid.innerHTML = '';
    activePalettes.forEach((pal, idx) => {
        const btn = document.createElement('button');
        btn.className = 'grid-btn texture-btn';
        btn.textContent = pal.name;
        btn.style.borderColor = pal.colorA;
        btn.onclick = () => engine.forcePalette(idx);
        textureGrid.appendChild(btn);
    });
  };
  updateTextureButtons();

  const loadCustomPalettes = () => {
    const saved = localStorage.getItem(CUSTOM_PALETTES_KEY);
    if (saved) {
      try {
        const custom = JSON.parse(saved);
        activePalettes = [...BASE_PALETTES, ...custom];
        updateTextureButtons();
      } catch (e) {
        activePalettes = [...BASE_PALETTES];
      }
    }
  };
  loadCustomPalettes();

  sizeSlider.oninput = (e) => {
    const val = parseFloat((e.target as HTMLInputElement).value);
    engine.setParticleSize(val);
  };

  lifespanSlider.oninput = (e) => {
    const val = parseFloat((e.target as HTMLInputElement).value);
    engine.setLifespanSpeed(val);
  };

  bloomSlider.oninput = (e) => {
    const val = parseFloat((e.target as HTMLInputElement).value);
    engine.setBloomIntensity(val);
  };

  addPaletteBtn.onclick = () => {
    const colorA = hexAInput.value.trim();
    const colorB = hexBInput.value.trim();
    if (/^#[0-9A-F]{6}$/i.test(colorA) && /^#[0-9A-F]{6}$/i.test(colorB)) {
      const newPalette: ColorPalette = { name: 'Custom', colorA, colorB };
      const custom = JSON.parse(localStorage.getItem(CUSTOM_PALETTES_KEY) || '[]');
      custom.push(newPalette);
      localStorage.setItem(CUSTOM_PALETTES_KEY, JSON.stringify(custom));
      activePalettes.push(newPalette);
      updateTextureButtons();
      statusEl.textContent = "Custom Palette Added.";
      engine.forcePalette(activePalettes.length - 1);
    } else {
      statusEl.textContent = "Invalid Hex Code.";
    }
    setTimeout(() => { if (statusEl.textContent?.includes("Palette") || statusEl.textContent?.includes("Hex")) statusEl.textContent = "Watching for hands..."; }, 2000);
  };

  clearPalettesBtn.onclick = () => {
    localStorage.removeItem(CUSTOM_PALETTES_KEY);
    activePalettes = [...BASE_PALETTES];
    updateTextureButtons();
    statusEl.textContent = "Palettes Reset.";
    engine.forcePalette(0);
    setTimeout(() => { if (statusEl.textContent === "Palettes Reset.") statusEl.textContent = "Watching for hands..."; }, 2000);
  };

  saveBtn.onclick = () => {
    engine.saveConfig();
    statusEl.textContent = "Configuration Saved.";
    setTimeout(() => { if (statusEl.textContent === "Configuration Saved.") statusEl.textContent = "Watching for hands..."; }, 2000);
  };

  loadBtn.onclick = () => {
    const loaded = engine.loadConfig();
    if (loaded) {
      statusEl.textContent = `Loaded: ${loaded.template}`;
    } else {
      statusEl.textContent = "No saved config found.";
    }
    setTimeout(() => { statusEl.textContent = "Watching for hands..."; }, 2000);
  };

  // @ts-ignore
  const hands = new Hands({
    locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
  });

  hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  });

  hands.onResults((results: any) => {
    ctx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
      statusEl.textContent = results.multiHandLandmarks.length === 2 ? "VALENTINE'S HEART DETECTED" : "Hand Detected";
      const primaryHand = results.multiHandLandmarks[0];
      const indexTip = primaryHand[8];
      const thumbTip = primaryHand[4];
      const wrist = primaryHand[0];
      const attractX = (1 - indexTip.x * 2) * 40;
      const attractY = (1 - indexTip.y * 2) * 30;
      const dist = Math.sqrt(Math.pow(indexTip.x - thumbTip.x, 2) + Math.pow(indexTip.y - thumbTip.y, 2));
      const expansion = 0.5 + dist * 5.0;

      if (results.multiHandLandmarks.length === 2) {
        engine.setTemplate('HEART');
        engine.forcePalette(5);
        engine.updatePhysics(1.2, 0, 0, true);
      } else {
        const palmSize = Math.sqrt(Math.pow(wrist.x - indexTip.x, 2));
        if (palmSize > 0.3) engine.setTemplate('HEART');
        else if (dist < 0.05) engine.setTemplate('SATURN');
        engine.updatePhysics(expansion, attractX, attractY, true);
      }

      results.multiHandLandmarks.forEach((hand: any) => {
          ctx.fillStyle = results.multiHandLandmarks.length === 2 ? "#ff0044" : "#00f2ff";
          hand.forEach((lm: any) => {
            ctx.beginPath();
            ctx.arc(lm.x * canvasElement.width, lm.y * canvasElement.height, 3, 0, 2 * Math.PI);
            ctx.fill();
          });
      });
    } else {
      statusEl.textContent = "Watching for hands...";
      engine.updatePhysics(1.0, 0, 0, false);
    }
  });

  startBtn.onclick = async () => {
    startBtn.disabled = true;
    startBtn.innerText = "OPENING...";
    statusEl.textContent = "Requesting permission...";
    hintEl.style.display = 'block';
    
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("MediaDevices API is not supported.");
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } catch (e) {
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
      }
      
      audio.init();

      overlay.classList.add('hidden');
      videoElement.srcObject = stream;
      
      await new Promise((resolve, reject) => {
        videoElement.onloadedmetadata = () => {
          videoElement.play().then(resolve).catch(reject);
        };
        setTimeout(() => reject(new Error("Camera timed out.")), 8000);
      });
      
      const detectFrame = async () => {
        if (videoElement.readyState >= 2) await hands.send({ image: videoElement });
        requestAnimationFrame(detectFrame);
      };
      requestAnimationFrame(detectFrame);
      statusEl.textContent = "Vision active.";
    } catch (err: any) {
      startBtn.disabled = false;
      startBtn.innerText = "RETRY ACCESS";
    }
  };

  function onResize() {
    canvasElement.width = videoElement.clientWidth || 240;
    canvasElement.height = videoElement.clientHeight || 180;
  }
  window.addEventListener('resize', onResize);
  onResize();
}

setupApp().catch(console.error);
