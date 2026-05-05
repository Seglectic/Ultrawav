import * as THREE from "three";

export type AudioNodeField = {
  update(input: { frequencyData: Uint8Array | null; timeData: Uint8Array | null; playing: boolean }): void;
  resize(): void;
  dispose(): void;
};

type AudioNodeFieldInput = Parameters<AudioNodeField["update"]>[0];

type AudioMetrics = {
  bass: number;
  mid: number;
  treble: number;
  waveform: number;
  activity: number;
  pulse: number;
};

type NodeState = {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
};

type FallbackNode = {
  x: number;
  y: number;
  vx: number;
  vy: number;
};

const NODE_COUNT = 96;
const CONNECTION_DISTANCE = 2.25;
const MAX_CONNECTIONS = 420;
const CAMERA_Z = 9;
const SCENE_DEPTH = 7;
const BASE_NODE_SIZE = 0.035;
const NODE_SIZE_GAIN = 0.062;
const ACTIVE_NODE_SIZE_BOOST = 0.014;
const PULSE_NODE_SIZE_BOOST = 0.02;
const ACTIVE_OPACITY_BOOST = 0.072;
const PULSE_OPACITY_BOOST = 0.095;
const BASE_DRIFT_SPEED = 0.00035;
const AUDIO_DRIFT_GAIN = 0.0078;
const FALLBACK_CONNECTION_DISTANCE_PX = 132;
const FALLBACK_NODE_RADIUS_PX = 1.8;
const FALLBACK_BASE_DRIFT_SPEED = 0.06;
const FALLBACK_ACTIVE_NODE_RADIUS_BOOST_PX = 0.72;
const FALLBACK_PULSE_NODE_RADIUS_BOOST_PX = 1.08;
const MIN_RENDER_SIZE_PX = 1;

const COLORS = {
  background: "#05070d",
  node: "#dbeafe",
  connection: "#60a5fa",
};

const SILENT_METRICS: AudioMetrics = {
  bass: 0,
  mid: 0,
  treble: 0,
  waveform: 0,
  activity: 0,
  pulse: 0,
};

export function createAudioNodeField(canvas: HTMLCanvasElement): AudioNodeField {
  try {
    return createThreeNodeField(canvas);
  } catch {
    return createFallbackNodeField(canvas);
  }
}

function createThreeNodeField(canvas: HTMLCanvasElement): AudioNodeField {
  const contextAttributes: WebGLContextAttributes = {
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
  };
  const webglContext =
    canvas.getContext("webgl2", contextAttributes) ??
    canvas.getContext("webgl", contextAttributes);

  if (!webglContext) {
    throw new Error("WebGL context unavailable for audio node field.");
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 100);
  camera.position.z = CAMERA_Z;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    context: webglContext as WebGLRenderingContext,
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(COLORS.background, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  styleCanvas(canvas);

  const nodes = createNodes();
  const pointPositions = new Float32Array(NODE_COUNT * 3);
  const pointGeometry = new THREE.BufferGeometry();
  const pointPositionAttribute = new THREE.BufferAttribute(pointPositions, 3);
  pointGeometry.setAttribute("position", pointPositionAttribute);

  const pointMaterial = new THREE.PointsMaterial({
    color: COLORS.node,
    size: BASE_NODE_SIZE,
    transparent: true,
    opacity: 0.88,
    depthWrite: false,
  });
  const points = new THREE.Points(pointGeometry, pointMaterial);
  scene.add(points);

  const linePositions = new Float32Array(MAX_CONNECTIONS * 2 * 3);
  const lineGeometry = new THREE.BufferGeometry();
  const linePositionAttribute = new THREE.BufferAttribute(linePositions, 3);
  lineGeometry.setAttribute("position", linePositionAttribute);
  lineGeometry.setDrawRange(0, 0);

  const lineMaterial = new THREE.LineBasicMaterial({
    color: COLORS.connection,
    transparent: true,
    opacity: 0.24,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
  scene.add(lines);

  let latestInput: AudioNodeFieldInput = {
    frequencyData: null,
    timeData: null,
    playing: false,
  };
  let animationFrame = 0;
  let disposed = false;
  let easedMetrics = { ...SILENT_METRICS };

  function update(input: AudioNodeFieldInput): void {
    latestInput = input;
  }

  function render(): void {
    if (disposed) {
      return;
    }

    easedMetrics = easeMetrics(easedMetrics, metricsFromInput(latestInput));
    const metrics = easedMetrics;
    updateNodes(nodes, metrics);
    writePointPositions(nodes, pointPositions);
    pointPositionAttribute.needsUpdate = true;
    pointMaterial.size = BASE_NODE_SIZE
      + metrics.treble * NODE_SIZE_GAIN
      + metrics.activity * ACTIVE_NODE_SIZE_BOOST
      + metrics.pulse * PULSE_NODE_SIZE_BOOST;
    pointMaterial.opacity = clamp(0.56 + metrics.treble * 0.1 + metrics.activity * (ACTIVE_OPACITY_BOOST + 0.2) + metrics.pulse * PULSE_OPACITY_BOOST, 0, 0.94);
    lineMaterial.opacity = clamp(0.075 + metrics.mid * 0.34 + metrics.activity * (ACTIVE_OPACITY_BOOST + 0.075) + metrics.pulse * PULSE_OPACITY_BOOST, 0, 0.56);
    writeConnections(nodes, linePositions, lineGeometry, CONNECTION_DISTANCE + metrics.bass * 0.72 + metrics.pulse * 0.32);
    points.rotation.y += 0.0007 + metrics.waveform * 0.0016 + metrics.pulse * 0.00135;
    lines.rotation.copy(points.rotation);
    renderer.render(scene, camera);
  }

  function resize(): void {
    const width = Math.max(MIN_RENDER_SIZE_PX, canvas.clientWidth || window.innerWidth);
    const height = Math.max(MIN_RENDER_SIZE_PX, canvas.clientHeight || window.innerHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  function animate(): void {
    render();
    animationFrame = window.requestAnimationFrame(animate);
  }

  function dispose(): void {
    disposed = true;
    window.cancelAnimationFrame(animationFrame);
    scene.remove(points);
    scene.remove(lines);
    pointGeometry.dispose();
    lineGeometry.dispose();
    pointMaterial.dispose();
    lineMaterial.dispose();
    renderer.dispose();
  }

  resize();
  animate();

  return { update, resize, dispose };
}

function createFallbackNodeField(canvas: HTMLCanvasElement): AudioNodeField {
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas context unavailable for audio node field.");
  }
  const renderingContext = context;

  styleCanvas(canvas);
  const nodes = createFallbackNodes();
  let latestInput: AudioNodeFieldInput = {
    frequencyData: null,
    timeData: null,
    playing: false,
  };
  let animationFrame = 0;
  let disposed = false;
  let easedMetrics = { ...SILENT_METRICS };

  function update(input: AudioNodeFieldInput): void {
    latestInput = input;
  }

  function render(): void {
    if (disposed) {
      return;
    }

    easedMetrics = easeMetrics(easedMetrics, metricsFromInput(latestInput));
    const metrics = easedMetrics;
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    renderingContext.fillStyle = COLORS.background;
    renderingContext.fillRect(0, 0, width, height);
    updateFallbackNodes(nodes, width, height, metrics);
    drawFallbackConnections(renderingContext, nodes, metrics);
    drawFallbackNodes(renderingContext, nodes, metrics);
  }

  function resize(): void {
    const devicePixelRatio = window.devicePixelRatio || 1;
    const width = Math.max(MIN_RENDER_SIZE_PX, canvas.clientWidth || window.innerWidth);
    const height = Math.max(MIN_RENDER_SIZE_PX, canvas.clientHeight || window.innerHeight);
    canvas.width = Math.round(width * devicePixelRatio);
    canvas.height = Math.round(height * devicePixelRatio);
    renderingContext.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }

  function animate(): void {
    render();
    animationFrame = window.requestAnimationFrame(animate);
  }

  function dispose(): void {
    disposed = true;
    window.cancelAnimationFrame(animationFrame);
    renderingContext.clearRect(0, 0, canvas.width, canvas.height);
  }

  resize();
  animate();

  return { update, resize, dispose };
}

function styleCanvas(canvas: HTMLCanvasElement): void {
  canvas.style.position = "fixed";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.pointerEvents = "none";
  canvas.style.zIndex = "0";
  canvas.style.display = "block";
}

function createNodes(): NodeState[] {
  const nodes: NodeState[] = [];
  for (let index = 0; index < NODE_COUNT; index += 1) {
    nodes.push({
      position: new THREE.Vector3(randomSigned(5.8), randomSigned(3.8), randomSigned(SCENE_DEPTH)),
      velocity: new THREE.Vector3(randomSigned(1), randomSigned(1), randomSigned(1)).normalize(),
    });
  }
  return nodes;
}

function createFallbackNodes(): FallbackNode[] {
  const nodes: FallbackNode[] = [];
  for (let index = 0; index < NODE_COUNT; index += 1) {
    nodes.push({
      x: Math.random(),
      y: Math.random(),
      vx: randomSigned(0.35),
      vy: randomSigned(0.35),
    });
  }
  return nodes;
}

function updateNodes(nodes: NodeState[], metrics: AudioMetrics): void {
  const speed = BASE_DRIFT_SPEED + metrics.bass * AUDIO_DRIFT_GAIN + metrics.activity * 0.0086 + metrics.pulse * 0.0032;
  const depthSpeed = speed * clamp(0.18 + metrics.activity * 2.4 + metrics.pulse * 0.4, 0.18, 1);
  for (const node of nodes) {
    node.position.x += node.velocity.x * speed;
    node.position.y += node.velocity.y * speed;
    node.position.z += node.velocity.z * depthSpeed;
    wrapAxis(node.position, "x", 6.2);
    wrapAxis(node.position, "y", 4.1);
    wrapAxis(node.position, "z", SCENE_DEPTH);
  }
}

function wrapAxis(position: THREE.Vector3, axis: "x" | "y" | "z", limit: number): void {
  if (position[axis] > limit) {
    position[axis] = -limit;
  } else if (position[axis] < -limit) {
    position[axis] = limit;
  }
}

function writePointPositions(nodes: readonly NodeState[], pointPositions: Float32Array): void {
  for (let index = 0; index < nodes.length; index += 1) {
    const offset = index * 3;
    const position = nodes[index].position;
    pointPositions[offset] = position.x;
    pointPositions[offset + 1] = position.y;
    pointPositions[offset + 2] = position.z;
  }
}

function writeConnections(
  nodes: readonly NodeState[],
  linePositions: Float32Array,
  lineGeometry: THREE.BufferGeometry,
  connectionDistance: number,
): void {
  let connectionCount = 0;
  for (let firstIndex = 0; firstIndex < nodes.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < nodes.length; secondIndex += 1) {
      if (connectionCount >= MAX_CONNECTIONS) {
        lineGeometry.setDrawRange(0, connectionCount * 2);
        lineGeometry.attributes.position.needsUpdate = true;
        return;
      }

      const first = nodes[firstIndex].position;
      const second = nodes[secondIndex].position;
      if (first.distanceToSquared(second) > connectionDistance * connectionDistance) {
        continue;
      }

      const offset = connectionCount * 6;
      linePositions[offset] = first.x;
      linePositions[offset + 1] = first.y;
      linePositions[offset + 2] = first.z;
      linePositions[offset + 3] = second.x;
      linePositions[offset + 4] = second.y;
      linePositions[offset + 5] = second.z;
      connectionCount += 1;
    }
  }

  lineGeometry.setDrawRange(0, connectionCount * 2);
  lineGeometry.attributes.position.needsUpdate = true;
}

function updateFallbackNodes(nodes: FallbackNode[], width: number, height: number, metrics: AudioMetrics): void {
  const speed = FALLBACK_BASE_DRIFT_SPEED + metrics.bass * 1.35 + metrics.activity * 0.95 + metrics.pulse * 0.62;
  for (const node of nodes) {
    node.x += (node.vx * speed) / Math.max(1, width);
    node.y += (node.vy * speed) / Math.max(1, height);

    if (node.x < 0 || node.x > 1) {
      node.vx *= -1;
      node.x = clamp(node.x, 0, 1);
    }
    if (node.y < 0 || node.y > 1) {
      node.vy *= -1;
      node.y = clamp(node.y, 0, 1);
    }
  }
}

function drawFallbackConnections(
  context: CanvasRenderingContext2D,
  nodes: readonly FallbackNode[],
  metrics: AudioMetrics,
): void {
  const width = context.canvas.clientWidth || window.innerWidth;
  const height = context.canvas.clientHeight || window.innerHeight;
  const distanceLimit = FALLBACK_CONNECTION_DISTANCE_PX + metrics.mid * 52 + metrics.pulse * 34;
  context.strokeStyle = COLORS.connection;
  context.globalAlpha = clamp(0.07 + metrics.mid * 0.34 + metrics.activity * 0.14 + metrics.pulse * 0.1, 0, 0.5);
  context.lineWidth = 1;

  for (let firstIndex = 0; firstIndex < nodes.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < nodes.length; secondIndex += 1) {
      const first = nodes[firstIndex];
      const second = nodes[secondIndex];
      const firstX = first.x * width;
      const firstY = first.y * height;
      const secondX = second.x * width;
      const secondY = second.y * height;
      const dx = firstX - secondX;
      const dy = firstY - secondY;
      if (dx * dx + dy * dy > distanceLimit * distanceLimit) {
        continue;
      }

      context.beginPath();
      context.moveTo(firstX, firstY);
      context.lineTo(secondX, secondY);
      context.stroke();
    }
  }
  context.globalAlpha = 1;
}

function drawFallbackNodes(
  context: CanvasRenderingContext2D,
  nodes: readonly FallbackNode[],
  metrics: AudioMetrics,
): void {
  const width = context.canvas.clientWidth || window.innerWidth;
  const height = context.canvas.clientHeight || window.innerHeight;
  context.fillStyle = COLORS.node;
  context.globalAlpha = clamp(0.56 + metrics.treble * 0.1 + metrics.activity * 0.28 + metrics.pulse * 0.09, 0, 0.96);

  for (const node of nodes) {
    context.beginPath();
    context.arc(
      node.x * width,
      node.y * height,
      FALLBACK_NODE_RADIUS_PX
        + metrics.treble * 2.65
        + metrics.activity * FALLBACK_ACTIVE_NODE_RADIUS_BOOST_PX
        + metrics.pulse * FALLBACK_PULSE_NODE_RADIUS_BOOST_PX,
      0,
      Math.PI * 2,
    );
    context.fill();
  }
  context.globalAlpha = 1;
}

function metricsFromInput(input: AudioNodeFieldInput): AudioMetrics {
  if (!input.frequencyData && !input.timeData) {
    return { ...SILENT_METRICS };
  }

  const bass = averageRange(input.frequencyData, 0, 0.18);
  const mid = averageRange(input.frequencyData, 0.18, 0.58);
  const treble = averageRange(input.frequencyData, 0.58, 1);
  const waveform = waveformEnergy(input.timeData);
  const pulse = input.playing ? clamp(bass * 1.05 + waveform * 0.5 + mid * 0.12, 0, 1) : 0;

  return {
    bass,
    mid,
    treble,
    waveform,
    activity: input.playing ? clamp(0.22 + bass * 0.48 + mid * 0.24 + waveform * 0.28, 0, 1) : 0,
    pulse,
  };
}

function easeMetrics(current: AudioMetrics, target: AudioMetrics): AudioMetrics {
  return {
    bass: easeValue(current.bass, target.bass, 0.13),
    mid: easeValue(current.mid, target.mid, 0.1),
    treble: easeValue(current.treble, target.treble, 0.1),
    waveform: easeValue(current.waveform, target.waveform, 0.14),
    activity: easeValue(current.activity, target.activity, target.activity > current.activity ? 0.023 : 0.018),
    pulse: easeValue(current.pulse, target.pulse, target.pulse > current.pulse ? 0.24 : 0.12),
  };
}

function easeValue(current: number, target: number, amount: number): number {
  return current + (target - current) * amount;
}

function averageRange(values: Uint8Array | null, startRatio: number, endRatio: number): number {
  if (!values || values.length === 0) {
    return 0;
  }

  const startIndex = Math.floor(values.length * startRatio);
  const endIndex = Math.max(startIndex + 1, Math.floor(values.length * endRatio));
  let sum = 0;
  for (let index = startIndex; index < endIndex; index += 1) {
    sum += values[index] / 255;
  }
  return clamp(sum / (endIndex - startIndex), 0, 1);
}

function waveformEnergy(values: Uint8Array | null): number {
  if (!values || values.length === 0) {
    return 0;
  }

  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    const normalized = (values[index] - 128) / 128;
    sum += normalized * normalized;
  }
  return clamp(Math.sqrt(sum / values.length), 0, 1);
}

function randomSigned(scale: number): number {
  return (Math.random() * 2 - 1) * scale;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
