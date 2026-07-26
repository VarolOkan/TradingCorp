// frontend/src/components/Options3DView.tsx
// 3D options chain visualizer ported from strikeview/3d/options_3d_poc.html.
// Renders options data as 3D bars (Three.js) with calls on the right, puts on
// the left, height = selected metric. No table view. Fullscreen supported.

import { useEffect, useRef, useCallback, useState } from 'react';
import type { OptionChainResult } from '../api/optionsHistoryClient';

/* ── helpers: dynamic Three.js loader ─────────────────────────────── */

const THREE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';

function loadThreeScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as any).THREE) { resolve(); return; }
    const existing = document.querySelector(`script[src="${THREE_CDN}"]`);
    if (existing) { existing.addEventListener('load', () => resolve()); return; }
    const s = document.createElement('script');
    s.src = THREE_CDN;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load Three.js'));
    document.head.appendChild(s);
  });
}

/* ── types ────────────────────────────────────────────────────────── */

export interface Options3DViewProps {
  chain: OptionChainResult;
  expiry: string;
  /** When true, the component fills the entire screen. */
  fullscreen?: boolean;
  /** Called when the user clicks the fullscreen exit button (inside the view). */
  onExitFullscreen?: () => void;
  /** Called when the user clicks the fullscreen toggle button in the sidebar. */
  onToggleFullscreen?: () => void;
}

interface Contract3D {
  strike: number;
  expiration: string;
  type: 'call' | 'put';
  bid: number;
  ask: number;
  last: number;
  volume: number;
  openInterest: number;
  impliedVolatility: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

interface Chain3D {
  ticker: string;
  underlyingPrice: number;
  expirations: string[];
  strikes: number[];
  contracts: Record<string, Contract3D>;
}

/* ── helpers ──────────────────────────────────────────────────────── */

const METRICS = [
  { value: 'volume', label: 'Volume' },
  { value: 'openInterest', label: 'Open Interest' },
  { value: 'ask', label: 'Ask' },
  { value: 'bid', label: 'Bid' },
  { value: 'last', label: 'Last' },
  { value: 'impliedVolatility', label: 'IV' },
  { value: 'delta', label: 'Delta' },
  { value: 'theta', label: 'Theta' },
] as const;

const COLOR_CALL = 0x26a69a;
const COLOR_PUT = 0xef5350;
const COLOR_ATM = 0xffeb3b;
const COLOR_CALL_HL = 0x7edd97;
const COLOR_PUT_HL = 0xf524e3;
const MAX_H = 15;

function convertChain(result: OptionChainResult): Chain3D {
  const contracts: Record<string, Contract3D> = {};
  const expSet = new Set<string>();
  const strikesSet = new Set<number>();

  for (const q of result.quotes) {
    const type = q.type === 'C' ? 'call' : 'put';
    const key = `${q.expiry}|${q.strike}|${type}`;
    contracts[key] = {
      strike: q.strike,
      expiration: q.expiry,
      type,
      bid: q.bid,
      ask: q.ask,
      last: q.last,
      volume: q.volume,
      openInterest: q.open_interest,
      impliedVolatility: q.iv,
      delta: 0,
      gamma: 0,
      theta: 0,
      vega: 0,
    };
    expSet.add(q.expiry);
    strikesSet.add(q.strike);
  }

  for (const g of result.greeks ?? []) {
    const type = g.type === 'C' ? 'call' : 'put';
    const key = `${g.expiry}|${g.strike}|${type}`;
    const c = contracts[key];
    if (c) {
      c.delta = g.delta;
      c.gamma = g.gamma;
      c.theta = g.theta;
      c.vega = g.vega;
    }
  }

  return {
    ticker: result.ticker,
    underlyingPrice: result.underlying_price,
    expirations: [...expSet].sort(),
    strikes: [...strikesSet].sort((a, b) => a - b),
    contracts,
  };
}

/* ── YOrbitControls (ported from POC) ────────────────────────────── */

class YOrbitControls {
  cam: any;
  el: HTMLElement;
  autoRotate = false;
  speed = 0.3;
  target: any;
  sph: any;
  dragging = false;
  prev = { x: 0, y: 0 };
  rotSpd = 0.005;

  constructor(cam: any, el: HTMLElement) {
    this.cam = cam;
    this.el = el;
    this.target = new (window as any).THREE.Vector3(0, 0, 0);
    this.sph = new (window as any).THREE.Spherical();
    const off = new (window as any).THREE.Vector3().subVectors(cam.position, this.target);
    this.sph.setFromVector3(off);

    el.addEventListener('mousedown', (e: MouseEvent) => {
      this.dragging = true;
      this.prev = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('mousemove', (e: MouseEvent) => {
      if (!this.dragging) return;
      this.sph.theta -= (e.clientX - this.prev.x) * this.rotSpd;
      this.sph.phi = Math.max(
        0.2,
        Math.min(Math.PI - 0.2, this.sph.phi - (e.clientY - this.prev.y) * this.rotSpd),
      );
      this.prev = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('mouseup', () => (this.dragging = false));
    el.addEventListener('mouseleave', () => (this.dragging = false));
    el.addEventListener(
      'wheel',
      (e: WheelEvent) => {
        e.preventDefault();
        this.sph.radius = Math.max(15, Math.min(150, this.sph.radius + e.deltaY * 0.1));
      },
      { passive: false },
    );
  }

  update() {
    if (this.autoRotate && !this.dragging) this.sph.theta += this.speed * 0.001;
    const off = new (window as any).THREE.Vector3().setFromSpherical(this.sph);
    this.cam.position.copy(this.target).add(off);
    this.cam.lookAt(this.target);
  }
}

/* ── component ────────────────────────────────────────────────────── */

export default function Options3DView({
  chain: chainResult,
  expiry,
  fullscreen = false,
  onExitFullscreen,
  onToggleFullscreen,
}: Options3DViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);
  const rendererRef = useRef<any>(null);
  const controlsRef = useRef<YOrbitControls | null>(null);
  const barsGroupRef = useRef<any>(null);
  const labelsGroupRef = useRef<any>(null);
  const axesGroupRef = useRef<any>(null);
  const chainRef = useRef<Chain3D | null>(null);
  const rafRef = useRef<number>(0);
  const [metric, setMetric] = useState<string>('volume');
  const [showNegPuts, setShowNegPuts] = useState(false);
  const [surfaceMode, setSurfaceMode] = useState(false);
  const [pillarSize, setPillarSize] = useState(1.2);
  const [threeReady, setThreeReady] = useState(false);
  const [expIdx, setExpIdx] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Load Three.js dynamically on mount
  useEffect(() => {
    loadThreeScript()
      .then(() => setThreeReady(true))
      .catch(console.error);
  }, []);

  // Convert TradingCorp data → POC chain format
  useEffect(() => {
    chainRef.current = convertChain(chainResult);
  }, [chainResult]);

  // ─── Scene init ─────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || !threeReady) return;
    const container = containerRef.current;
    const THREE_LOCAL = (window as any).THREE;

    const scene = new THREE_LOCAL.Scene();
    scene.background = new THREE_LOCAL.Color(0x1a1a2e);
    scene.fog = new THREE_LOCAL.Fog(0x1a1a2e, 80, 200);

    const w = container.clientWidth || 800;
    const h = container.clientHeight || 500;
    const camera = new THREE_LOCAL.PerspectiveCamera(50, w / h, 0.1, 500);
    camera.position.set(50, 40, 60);

    const renderer = new THREE_LOCAL.WebGLRenderer({ antialias: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);

    scene.add(new THREE_LOCAL.AmbientLight(0x404060, 0.6));
    const dl = new THREE_LOCAL.DirectionalLight(0xffffff, 0.8);
    dl.position.set(30, 50, 30);
    dl.castShadow = true;
    scene.add(dl);
    const bl = new THREE_LOCAL.DirectionalLight(0x4fc3f7, 0.3);
    bl.position.set(-20, 20, -20);
    scene.add(bl);

    const grid = new THREE_LOCAL.GridHelper(120, 30, 0x333355, 0x222244);
    grid.position.y = -0.5;
    scene.add(grid);

    const barsGroup = new THREE_LOCAL.Group();
    scene.add(barsGroup);
    const labelsGroup = new THREE_LOCAL.Group();
    scene.add(labelsGroup);
    const axesGroup = new THREE_LOCAL.Group();
    scene.add(axesGroup);

    const controls = new YOrbitControls(camera, renderer.domElement);

    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;
    barsGroupRef.current = barsGroup;
    labelsGroupRef.current = labelsGroup;
    axesGroupRef.current = axesGroup;
    controlsRef.current = controls;

    let running = true;
    function anim() {
      if (!running) return;
      rafRef.current = requestAnimationFrame(anim);
      controls.update();
      renderer.render(scene, camera);
    }
    anim();

    const onResize = () => {
      const w2 = container.clientWidth;
      const h2 = container.clientHeight;
      if (w2 && h2) {
        camera.aspect = w2 / h2;
        camera.updateProjectionMatrix();
        renderer.setSize(w2, h2);
      }
    };
    window.addEventListener('resize', onResize);

    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      sceneRef.current = null;
      rendererRef.current = null;
    };
  }, [threeReady]);

  // ─── Rebuild 3D bars/labels when data, metric or options change ──
  const rebuild = useCallback(() => {
    const scene = sceneRef.current;
    const barsGroup = barsGroupRef.current;
    const labelsGroup = labelsGroupRef.current;
    const axesGroup = axesGroupRef.current;
    const chain = chainRef.current;
    if (!scene || !barsGroup || !chain) return;

    const THREE_LOCAL = (window as any).THREE;

    // Clear old bars
    while (barsGroup.children.length) {
      const c = barsGroup.children[0];
      barsGroup.remove(c);
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }

    if (surfaceMode) {
      buildSurface(chain, metric, barsGroup, THREE_LOCAL);
    } else {
      buildBars(chain, metric, barsGroup, THREE_LOCAL);
    }
    buildLabelsAndAxes(chain, metric, labelsGroup, axesGroup, THREE_LOCAL);
  }, [metric, showNegPuts, surfaceMode, pillarSize, chainResult, expIdx]);

  useEffect(() => {
    rebuild();
  }, [rebuild, expiry, threeReady]);

  // ─── buildBars ──────────────────────────────────────────────────
  function buildBars(chain: Chain3D, metricName: string, group: any, THREE_LOCAL: any) {
    const exps = chain.expirations;
    const strikes = chain.strikes;
    const barW = pillarSize;
    const barD = pillarSize;
    const stepX = 2.4;
    const stepZ = 1.8;

    let maxV = 0;
    for (const k in chain.contracts) {
      const v = Math.abs((chain.contracts[k] as any)[metricName] || 0);
      if (v > maxV) maxV = v;
    }

    const centerStrike = findAtmStrike(strikes, chain.underlyingPrice);
    const centerIdx = centerStrike !== null ? strikes.indexOf(centerStrike) : Math.floor(strikes.length / 2);
    const so = -centerIdx * stepZ;

    for (let ei = 0; ei < exps.length; ei++) {
      const atmStrike = findAtmStrikeForExp(chain, exps[ei], chain.underlyingPrice);
      for (let si = 0; si < strikes.length; si++) {
        const exp = exps[ei];
        const st = strikes[si];
        const isAtm = st === atmStrike;

        for (const type of ['call', 'put'] as const) {
          const ct = chain.contracts[`${exp}|${st}|${type}`];
          if (!ct) continue;
          const rawV = (ct as any)[metricName] || 0;
          const v = showNegPuts && type === 'put' ? -rawV : rawV;
          const h = maxV > 0 ? Math.max(0.1, (Math.abs(v) / maxV) * MAX_H) : 0.1;

          let color: number;
          if (isAtm) {
            color = COLOR_ATM;
          } else if (expIdx > 0 && ei === expIdx - 1) {
            color = type === 'call' ? COLOR_CALL_HL : COLOR_PUT_HL;
          } else if (type === 'call') {
            color = COLOR_CALL;
          } else {
            color = COLOR_PUT;
          }

          const m = new THREE_LOCAL.Mesh(
            new THREE_LOCAL.BoxGeometry(barW, h, barD),
            new THREE_LOCAL.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.2 }),
          );

          const cellZ = so + si * stepZ;
          let posX: number;
          if (type === 'put') {
            posX = showNegPuts ? (ei + 1) * stepX : -(ei + 1) * stepX;
          } else {
            posX = (ei + 1) * stepX;
          }
          const posY = showNegPuts && type === 'put' ? -h / 2 : h / 2;

          m.position.set(posX, posY, cellZ);
          m.castShadow = true;
          m.receiveShadow = true;
          m.userData = { contract: ct };
          group.add(m);
        }
      }
    }
  }

  // ─── buildSurface ───────────────────────────────────────────────
  function buildSurface(chain: Chain3D, metricName: string, group: any, THREE_LOCAL: any) {
    const exps = chain.expirations;
    const strikes = chain.strikes;
    const stepX = 2.4;
    const stepZ = 1.8;

    let maxV = 0;
    for (const k in chain.contracts) {
      const v = Math.abs((chain.contracts[k] as any)[metricName] || 0);
      if (v > maxV) maxV = v;
    }

    const centerStrike = findAtmStrike(strikes, chain.underlyingPrice);
    const centerIdx = centerStrike !== null ? strikes.indexOf(centerStrike) : Math.floor(strikes.length / 2);
    const so = -centerIdx * stepZ;

    // Build call surface
    const callVerts: number[] = [];
    for (let si = 0; si < strikes.length; si++) {
      for (let ei = 0; ei < exps.length; ei++) {
        const ct = chain.contracts[`${exps[ei]}|${strikes[si]}|call`];
        if (!ct) {
          callVerts.push((ei + 1) * stepX, NaN, so + si * stepZ);
          continue;
        }
        const v = (ct as any)[metricName] || 0;
        const h = maxV > 0 ? Math.max(0.05, (v / maxV) * MAX_H) : 0.05;
        callVerts.push((ei + 1) * stepX, h, so + si * stepZ);
      }
    }
    fillNaNGapsZ(callVerts, exps.length, strikes.length);
    buildSurfaceMesh(callVerts, exps.length, strikes.length, stepX, stepZ, so, 0x26a69a, 0.35, group, THREE_LOCAL);

    // Build put surface
    const putVerts: number[] = [];
    for (let si = 0; si < strikes.length; si++) {
      for (let ei = 0; ei < exps.length; ei++) {
        const ct = chain.contracts[`${exps[ei]}|${strikes[si]}|put`];
        if (!ct) {
          putVerts.push(showNegPuts ? (ei + 1) * stepX : -(ei + 1) * stepX, NaN, so + si * stepZ);
          continue;
        }
        const v = Math.abs((ct as any)[metricName] || 0);
        const h = maxV > 0 ? Math.max(0.05, (v / maxV) * MAX_H) : 0.05;
        const putH = showNegPuts ? -h : h;
        const x = showNegPuts ? (ei + 1) * stepX : -(ei + 1) * stepX;
        putVerts.push(x, putH, so + si * stepZ);
      }
    }
    fillNaNGapsZ(putVerts, exps.length, strikes.length);
    buildSurfaceMesh(putVerts, exps.length, strikes.length, stepX, stepZ, so, 0xef5350, 0.35, group, THREE_LOCAL);
  }

  function fillNaNGapsZ(verts: number[], cols: number, rows: number) {
    for (let ei = 0; ei < cols; ei++) {
      for (let si = 0; si < rows; si++) {
        const idx = (si * cols + ei) * 3 + 1;
        if (!isNaN(verts[idx])) continue;
        let aboveH = NaN;
        let aboveDist = 0;
        let belowH = NaN;
        let belowDist = 0;
        for (let a = si - 1; a >= 0; a--) {
          aboveDist++;
          if (!isNaN(verts[(a * cols + ei) * 3 + 1])) {
            aboveH = verts[(a * cols + ei) * 3 + 1];
            break;
          }
        }
        for (let b = si + 1; b < rows; b++) {
          belowDist++;
          if (!isNaN(verts[(b * cols + ei) * 3 + 1])) {
            belowH = verts[(b * cols + ei) * 3 + 1];
            break;
          }
        }
        if (!isNaN(aboveH) && !isNaN(belowH)) {
          verts[idx] = (aboveH * belowDist + belowH * aboveDist) / (aboveDist + belowDist);
        } else if (!isNaN(aboveH)) {
          verts[idx] = aboveH;
        } else if (!isNaN(belowH)) {
          verts[idx] = belowH;
        }
      }
    }
  }

  function buildSurfaceMesh(
    verts: number[],
    cols: number,
    rows: number,
    _stepX: number,
    _stepZ: number,
    _so: number,
    color: number,
    alpha: number,
    group: any,
    THREE_LOCAL: any,
  ) {
    const sub = 4;
    const sCols = (cols - 1) * sub + 1;
    const sRows = (rows - 1) * sub + 1;
    const positions: number[] = [];

    for (let sr = 0; sr < sRows; sr++) {
      for (let sc = 0; sc < sCols; sc++) {
        const origR = sr / sub;
        const origC = sc / sub;
        const r0 = Math.floor(origR);
        const c0 = Math.floor(origC);
        const r1 = Math.min(r0 + 1, rows - 1);
        const c1 = Math.min(c0 + 1, cols - 1);
        const fr = origR - r0;
        const fc = origC - c0;

        const i00 = (r0 * cols + c0) * 3;
        const i01 = (r0 * cols + c1) * 3;
        const i10 = (r1 * cols + c0) * 3;
        const i11 = (r1 * cols + c1) * 3;
        const h00 = verts[i00 + 1];
        const h01 = verts[i01 + 1];
        const h10 = verts[i10 + 1];
        const h11 = verts[i11 + 1];

        if (isNaN(h00) || isNaN(h01) || isNaN(h10) || isNaN(h11)) {
          const x = verts[i00] * (1 - fc) * (1 - fr) + verts[i01] * fc * (1 - fr) + verts[i10] * (1 - fc) * fr + verts[i11] * fc * fr;
          const z = verts[i00 + 2] * (1 - fc) * (1 - fr) + verts[i01 + 2] * fc * (1 - fr) + verts[i10 + 2] * (1 - fc) * fr + verts[i11 + 2] * fc * fr;
          positions.push(x, NaN, z);
        } else {
          const h = h00 * (1 - fc) * (1 - fr) + h01 * fc * (1 - fr) + h10 * (1 - fc) * fr + h11 * fc * fr;
          const x = verts[i00] * (1 - fc) * (1 - fr) + verts[i01] * fc * (1 - fr) + verts[i10] * (1 - fc) * fr + verts[i11] * fc * fr;
          const z = verts[i00 + 2] * (1 - fc) * (1 - fr) + verts[i01 + 2] * fc * (1 - fr) + verts[i10 + 2] * (1 - fc) * fr + verts[i11 + 2] * fc * fr;
          positions.push(x, h, z);
        }
      }
    }

    const indices: number[] = [];
    for (let r = 0; r < sRows - 1; r++) {
      for (let c = 0; c < sCols - 1; c++) {
        const tl = r * sCols + c;
        const tr = r * sCols + c + 1;
        const bl = (r + 1) * sCols + c;
        const br = (r + 1) * sCols + c + 1;
        const tlY = positions[tl * 3 + 1];
        const trY = positions[tr * 3 + 1];
        const blY = positions[bl * 3 + 1];
        const brY = positions[br * 3 + 1];
        if (!isNaN(tlY) && !isNaN(trY) && !isNaN(blY)) indices.push(tl, bl, tr);
        if (!isNaN(trY) && !isNaN(blY) && !isNaN(brY)) indices.push(tr, bl, br);
      }
    }
    if (indices.length === 0) return;
    for (let i = 0; i < positions.length; i++) {
      if (isNaN(positions[i])) positions[i] = 0;
    }

    const geo = new THREE_LOCAL.BufferGeometry();
    geo.setAttribute('position', new THREE_LOCAL.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const mat = new THREE_LOCAL.MeshStandardMaterial({
      color,
      transparent: true,
      opacity: alpha,
      side: THREE_LOCAL.DoubleSide,
      roughness: 0.5,
      metalness: 0.1,
      wireframe: false,
    });
    const mesh = new THREE_LOCAL.Mesh(geo, mat);
    group.add(mesh);

    const wireMat = new THREE_LOCAL.MeshBasicMaterial({
      color,
      wireframe: true,
      transparent: true,
      opacity: 0.6,
    });
    const wireGeo = new THREE_LOCAL.BufferGeometry();
    wireGeo.setAttribute('position', new THREE_LOCAL.Float32BufferAttribute(positions, 3));
    wireGeo.setIndex(indices);
    const wireMesh = new THREE_LOCAL.Mesh(wireGeo, wireMat);
    group.add(wireMesh);
  }

  // ─── buildLabelsAndAxes ─────────────────────────────────────────
  function buildLabelsAndAxes(
    chain: Chain3D,
    metricName: string,
    labelsGroup: any,
    axesGroup: any,
    THREE_LOCAL: any,
  ) {
    // Clear old labels
    while (labelsGroup.children.length) {
      const c = labelsGroup.children[0];
      labelsGroup.remove(c);
      if (c.material && c.material.map) c.material.map.dispose();
      if (c.material) c.material.dispose();
    }
    while (axesGroup.children.length) {
      const c = axesGroup.children[0];
      axesGroup.remove(c);
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }

    const exps = chain.expirations;
    const strikes = chain.strikes;
    if (!exps.length || !strikes.length) return;

    const stepX = 2.4;
    const stepZ = 1.8;

    // Grid offsets
    const centerStrike = findAtmStrike(strikes, chain.underlyingPrice);
    const centerIdx = centerStrike !== null ? strikes.indexOf(centerStrike) : Math.floor(strikes.length / 2);
    const so = -centerIdx * stepZ;
    const gridStepX = stepX;
    const gridStepZ = stepZ;

    // X-axis: Expiration dates (mirrored)
    const xLineLen = exps.length * gridStepX * 2 + 4;
    const centerLine = new THREE_LOCAL.Line(
      new THREE_LOCAL.BufferGeometry().setFromPoints([
        new THREE_LOCAL.Vector3(0, -0.5, so - 2),
        new THREE_LOCAL.Vector3(0, -0.5, so + 2),
      ]),
      new THREE_LOCAL.LineBasicMaterial({ color: 0x4fc3f7 }),
    );
    axesGroup.add(centerLine);

    if (!showNegPuts) {
      const leftLine = new THREE_LOCAL.Line(
        new THREE_LOCAL.BufferGeometry().setFromPoints([
          new THREE_LOCAL.Vector3(-xLineLen / 2, -0.5, so - 2),
          new THREE_LOCAL.Vector3(-0.3, -0.5, so - 2),
        ]),
        new THREE_LOCAL.LineBasicMaterial({ color: 0xef5350 }),
      );
      axesGroup.add(leftLine);
    }

    const rightLine = new THREE_LOCAL.Line(
      new THREE_LOCAL.BufferGeometry().setFromPoints([
        new THREE_LOCAL.Vector3(0.3, -0.5, so - 2),
        new THREE_LOCAL.Vector3(xLineLen / 2, -0.5, so - 2),
      ]),
      new THREE_LOCAL.LineBasicMaterial({ color: 0x26a69a }),
    );
    axesGroup.add(rightLine);

    for (let ei = 0; ei < exps.length; ei++) {
      const dateStr = exps[ei].slice(5);
      if (!showNegPuts) {
        const putLabel = makeTextSprite(dateStr, { fontSize: 20, color: '#ef5350' }, THREE_LOCAL);
        putLabel.position.set(-(ei + 1) * gridStepX, -1.5, so - 2);
        labelsGroup.add(putLabel);
      }
      const callLabel = makeTextSprite(dateStr, { fontSize: 20, color: '#26a69a' }, THREE_LOCAL);
      callLabel.position.set((ei + 1) * gridStepX, -1.5, so - 2);
      labelsGroup.add(callLabel);
    }

    if (!showNegPuts) {
      const putsTitle = makeTextSprite('PUTS ←', { fontSize: 20, color: '#ef5350' }, THREE_LOCAL);
      putsTitle.position.set((-exps.length * gridStepX) / 2 - 1, -2.5, so - 2);
      labelsGroup.add(putsTitle);
    }
    const callsTitle = makeTextSprite('→ CALLS', { fontSize: 20, color: '#26a69a' }, THREE_LOCAL);
    callsTitle.position.set((exps.length * gridStepX) / 2 + 1, -2.5, so - 2);
    labelsGroup.add(callsTitle);

    // Z-axis: Strike prices
    const zLineLen = (strikes.length - 1) * gridStepZ + 4;
    const zLine = new THREE_LOCAL.Line(
      new THREE_LOCAL.BufferGeometry().setFromPoints([
        new THREE_LOCAL.Vector3(-2, -0.5, -zLineLen / 2),
        new THREE_LOCAL.Vector3(-2, -0.5, zLineLen / 2),
      ]),
      new THREE_LOCAL.LineBasicMaterial({ color: 0x555577 }),
    );
    axesGroup.add(zLine);

    for (let si = 0; si < strikes.length; si++) {
      const isAtm = strikes[si] === findAtmStrike(strikes, chain.underlyingPrice);
      const label = makeTextSprite('$' + strikes[si], { fontSize: 20, color: isAtm ? '#ffeb3b' : '#666' }, THREE_LOCAL);
      label.position.set(-2, -1.5, so + si * gridStepZ);
      labelsGroup.add(label);
    }

    const zTitle = makeTextSprite('Strike', { fontSize: 20, color: '#4fc3f7' }, THREE_LOCAL);
    zTitle.position.set(0, -2.5, 0);
    labelsGroup.add(zTitle);

    // Y-axis: Value scale
    let maxV = 0;
    for (const k in chain.contracts) {
      const v = Math.abs((chain.contracts[k] as any)[metricName] || 0);
      if (v > maxV) maxV = v;
    }

    const yAxisX = 0;
    const yAxisZ = 0;

    const shaftGeo = new THREE_LOCAL.CylinderGeometry(0.08, 0.08, MAX_H + 1, 8);
    const shaftMat = new THREE_LOCAL.MeshStandardMaterial({ color: 0xffeb3b, roughness: 0.4, metalness: 0.3 });
    const shaft = new THREE_LOCAL.Mesh(shaftGeo, shaftMat);
    shaft.position.set(yAxisX, (MAX_H + 1) / 2, yAxisZ);
    axesGroup.add(shaft);

    const coneGeo = new THREE_LOCAL.ConeGeometry(0.25, 0.6, 8);
    const coneMat = new THREE_LOCAL.MeshStandardMaterial({ color: 0xffeb3b, roughness: 0.4, metalness: 0.3 });
    const cone = new THREE_LOCAL.Mesh(coneGeo, coneMat);
    cone.position.set(yAxisX, MAX_H + 1 + 0.3, yAxisZ);
    axesGroup.add(cone);

    for (let i = 0; i <= 4; i++) {
      const val = maxV > 0 ? (maxV * i) / 4 : 0;
      const y = (MAX_H * i) / 4;
      const tickGeo = new THREE_LOCAL.CylinderGeometry(0.04, 0.04, 0.4, 6);
      const tickMat = new THREE_LOCAL.MeshStandardMaterial({ color: 0xffeb3b, roughness: 0.4, metalness: 0.3 });
      const tickMesh = new THREE_LOCAL.Mesh(tickGeo, tickMat);
      tickMesh.rotation.z = Math.PI / 2;
      tickMesh.position.set(yAxisX + 0.3, y, yAxisZ);
      axesGroup.add(tickMesh);
      const lbl = makeTextSprite(
        val >= 1000 ? (val / 1000).toFixed(1) + 'k' : val.toFixed(0),
        { fontSize: 18, color: '#ffeb3b' },
        THREE_LOCAL,
      );
      lbl.position.set(showNegPuts ? yAxisX - 1.2 : yAxisX + 1.2, y, yAxisZ);
      labelsGroup.add(lbl);
    }

    const metricLabel = METRICS.find((m) => m.value === metricName)?.label ?? metricName;
    const yTitle = makeTextSprite(metricLabel, { fontSize: 20, color: '#4fc3f7' }, THREE_LOCAL);
    yTitle.position.set(yAxisX, MAX_H / 2, yAxisZ - 2);
    labelsGroup.add(yTitle);

    // Mirrored Y-axis below floor when Puts Negative is on
    if (showNegPuts) {
      const downShaft = new THREE_LOCAL.Mesh(
        new THREE_LOCAL.CylinderGeometry(0.08, 0.08, MAX_H + 1, 8),
        new THREE_LOCAL.MeshStandardMaterial({ color: 0xffeb3b, roughness: 0.4, metalness: 0.3 }),
      );
      downShaft.position.set(yAxisX, -(MAX_H + 1) / 2, yAxisZ);
      axesGroup.add(downShaft);

      const downCone = new THREE_LOCAL.Mesh(
        new THREE_LOCAL.ConeGeometry(0.25, 0.6, 8),
        new THREE_LOCAL.MeshStandardMaterial({ color: 0xffeb3b, roughness: 0.4, metalness: 0.3 }),
      );
      downCone.rotation.z = Math.PI;
      downCone.position.set(yAxisX, -(MAX_H + 1) - 0.3, yAxisZ);
      axesGroup.add(downCone);

      for (let i = 1; i <= 4; i++) {
        const val = maxV > 0 ? (maxV * i) / 4 : 0;
        const y = (-MAX_H * i) / 4;
        const tickMesh = new THREE_LOCAL.Mesh(
          new THREE_LOCAL.CylinderGeometry(0.04, 0.04, 0.4, 6),
          new THREE_LOCAL.MeshStandardMaterial({ color: 0xffeb3b, roughness: 0.4, metalness: 0.3 }),
        );
        tickMesh.rotation.z = Math.PI / 2;
        tickMesh.position.set(yAxisX + 0.3, y, yAxisZ);
        axesGroup.add(tickMesh);
        const lbl = makeTextSprite(
          '-' + (val >= 1000 ? (val / 1000).toFixed(1) + 'k' : val.toFixed(0)),
          { fontSize: 18, color: '#ffeb3b' },
          THREE_LOCAL,
        );
        lbl.position.set(yAxisX - 1.4, y, yAxisZ);
        labelsGroup.add(lbl);
      }
    }

    // Origin label
    const originLabel = makeTextSprite(
      'ATM: $' + (chain.underlyingPrice || '?'),
      { fontSize: 18, color: '#ffeb3b' },
      THREE_LOCAL,
    );
    originLabel.position.set(0, -2.5, -2);
    labelsGroup.add(originLabel);
  }

  function makeTextSprite(text: string, opts: { fontSize?: number; color?: string } = {}, THREE_LOCAL: any) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const fontSize = opts.fontSize || 28;
    ctx.font = `${fontSize}px -apple-system, sans-serif`;
    const w = ctx.measureText(text).width;
    canvas.width = w + 16;
    canvas.height = fontSize + 12;
    ctx.font = `${fontSize}px -apple-system, sans-serif`;
    ctx.fillStyle = opts.color || '#888';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 8, canvas.height / 2);
    const tex = new THREE_LOCAL.CanvasTexture(canvas);
    const mat = new THREE_LOCAL.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    const sprite = new THREE_LOCAL.Sprite(mat);
    sprite.scale.set(canvas.width / 40, canvas.height / 40, 1);
    return sprite;
  }

  // ─── ATM helpers ────────────────────────────────────────────────
  function findAtmStrike(strikes: number[], underlyingPrice: number): number | null {
    if (!underlyingPrice || !strikes.length) return null;
    let best = strikes[0];
    let bestDist = Math.abs(strikes[0] - underlyingPrice);
    for (let i = 1; i < strikes.length; i++) {
      const d = Math.abs(strikes[i] - underlyingPrice);
      if (d < bestDist) {
        bestDist = d;
        best = strikes[i];
      }
    }
    return best;
  }

  function findAtmStrikeForExp(chain: Chain3D, exp: string, underlyingPrice: number): number | null {
    if (!underlyingPrice) return null;
    const strikesInExp = new Set<number>();
    for (const k in chain.contracts) {
      if (k.startsWith(exp + '|')) {
        strikesInExp.add(chain.contracts[k].strike);
      }
    }
    const strikes = [...strikesInExp].sort((a, b) => a - b);
    return findAtmStrike(strikes, underlyingPrice);
  }

  const expirations = chainRef.current?.expirations ?? [];
  const expLabel = expIdx === 0 ? 'All' : (expirations[expIdx - 1] ?? 'All');

  return (
    <div
      className={`options-3d-view ${fullscreen ? 'options-3d-fullscreen' : ''}`}
      data-testid="options-3d-view"
    >
      {/* Expiry slider bar — full width at top, above the sidebar */}
      <div className="options-3d-expbar" data-testid="options-3d-expbar">
        <span className="options-3d-expbar-label">{expLabel}</span>
        <input
          type="range"
          className="options-3d-expbar-slider"
          min={0}
          max={Math.max(expirations.length, 1)}
          step={1}
          value={expIdx}
          onChange={(e) => setExpIdx(parseInt(e.target.value, 10))}
          data-testid="options-3d-expslider"
        />
      </div>
      {/* Body: sidebar overlay + collapse btn + canvas */}
      <div className={`options-3d-body ${sidebarCollapsed ? 'collapsed' : ''}`}>
        {/* Left sidebar — controls, legend, fullscreen */}
        <div className="options-3d-sidebar-wrap">
          <div className="options-3d-sidebar" data-testid="options-3d-sidebar">
            <div className="options-3d-sidebar-title">📊 Options 3D</div>
            <label className="options-3d-label">
              Metric
              <select value={metric} onChange={(e) => setMetric(e.target.value)} data-testid="options-3d-metric">
                {METRICS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </label>
            <label className="options-3d-label">
              Pillar
              <span className="options-3d-pillar-val">{pillarSize.toFixed(2)}</span>
              <input
                type="range"
                min={0.1}
                max={1.5}
                step={0.05}
                value={pillarSize}
                onChange={(e) => setPillarSize(parseFloat(e.target.value))}
                className="options-3d-slider"
                data-testid="options-3d-pillar"
              />
            </label>
            <button
              type="button"
              className={`options-3d-btn ${showNegPuts ? 'active-toggle' : 'secondary'}`}
              onClick={() => setShowNegPuts((p) => !p)}
              data-testid="options-3d-negputs"
            >
              {showNegPuts ? '▲ Puts Positive' : '▼ Puts Negative'}
            </button>
            <button
              type="button"
              className={`options-3d-btn ${surfaceMode ? 'active-toggle' : 'secondary'}`}
              onClick={() => setSurfaceMode((p) => !p)}
              data-testid="options-3d-surface"
            >
              {surfaceMode ? '▣ Pillar View' : '▦ Surface View'}
            </button>
            <button
              type="button"
              className="options-3d-btn secondary"
              onClick={() => {
                if (controlsRef.current) controlsRef.current.autoRotate = !controlsRef.current.autoRotate;
              }}
              data-testid="options-3d-rotate"
            >
              ▶ Auto-Rotate
            </button>
            {onToggleFullscreen && (
              <button
                type="button"
                className={`options-3d-btn ${fullscreen ? 'active-toggle' : 'secondary'}`}
                onClick={onToggleFullscreen}
                data-testid="options-3d-fullscreen-btn"
                title={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              >
                {fullscreen ? '⊡ Exit FS' : '⛶ Fullscreen'}
              </button>
            )}
            {fullscreen && (
              <button
                type="button"
                className="options-3d-btn options-3d-exit-fullscreen"
                onClick={onExitFullscreen}
                data-testid="options-3d-exit-fullscreen"
                title="Exit fullscreen"
              >
                ✕ Exit Fullscreen
              </button>
            )}
          </div>
        </div>
        {/* Collapse toggle — absolute within body, shifts with sidebar */}
        <button
          type="button"
          className="options-3d-collapse-btn"
          onClick={() => setSidebarCollapsed((c) => !c)}
          data-testid="options-3d-collapse-btn"
          title={sidebarCollapsed ? 'Expand controls' : 'Collapse controls'}
        >
          {sidebarCollapsed ? '»' : '«'}
        </button>
        {/* 3D canvas */}
        <div className="options-3d-canvas-wrap">
          {!threeReady && (
            <div className="options-3d-loading" data-testid="options-3d-loading">
              <span className="options-3d-spinner" /> Loading 3D engine…
            </div>
          )}
          <div ref={containerRef} className="options-3d-container" data-testid="options-3d-container" />
          {/* Floating legend — bottom-right */}
          <div className="options-3d-legend">
            <div className="options-3d-legend-item">
              <span className="options-3d-legend-box" style={{ background: '#ef5350' }} /> Puts (← left)
            </div>
            <div className="options-3d-legend-item">
              <span className="options-3d-legend-box" style={{ background: '#26a69a' }} /> Calls (→ right)
            </div>
            <div className="options-3d-legend-item">
              <span className="options-3d-legend-box" style={{ background: '#ffeb3b' }} /> ATM Strike
            </div>
            <div className="options-3d-hint">
              Puts ← | → Calls<br />
              Z → Strike | Y → Value<br />
              Drag: rotate | Scroll: zoom
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
