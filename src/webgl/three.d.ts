declare module "three" {
  export class Vector3 {
    x: number;
    y: number;
    z: number;
    constructor(x?: number, y?: number, z?: number);
    addScaledVector(vector: Vector3, scale: number): this;
    distanceToSquared(vector: Vector3): number;
    normalize(): this;
  }

  export class Euler {
    x: number;
    y: number;
    z: number;
    copy(euler: Euler): this;
  }

  export class Scene {
    add(object: object): this;
    remove(object: object): this;
  }

  export class PerspectiveCamera {
    aspect: number;
    position: Vector3;
    constructor(fieldOfView: number, aspect: number, near: number, far: number);
    updateProjectionMatrix(): void;
  }

  export class WebGLRenderer {
    domElement: HTMLCanvasElement;
    constructor(parameters: {
      canvas?: HTMLCanvasElement;
      context?: WebGLRenderingContext;
      alpha?: boolean;
      antialias?: boolean;
      powerPreference?: WebGLPowerPreference;
    });
    dispose(): void;
    render(scene: Scene, camera: PerspectiveCamera): void;
    setClearColor(color: string, alpha?: number): void;
    setPixelRatio(value: number): void;
    setSize(width: number, height: number, updateStyle?: boolean): void;
  }

  export class BufferAttribute {
    needsUpdate: boolean;
    constructor(array: Float32Array, itemSize: number);
  }

  export class BufferGeometry {
    attributes: { position: BufferAttribute };
    dispose(): void;
    setAttribute(name: string, attribute: BufferAttribute): this;
    setDrawRange(start: number, count: number): void;
  }

  export class PointsMaterial {
    opacity: number;
    size: number;
    constructor(parameters: {
      color?: string;
      size?: number;
      transparent?: boolean;
      opacity?: number;
      depthWrite?: boolean;
    });
    dispose(): void;
  }

  export class LineBasicMaterial {
    opacity: number;
    constructor(parameters: {
      color?: string;
      transparent?: boolean;
      opacity?: number;
      depthWrite?: boolean;
    });
    dispose(): void;
  }

  export class Points {
    rotation: Euler;
    constructor(geometry: BufferGeometry, material: PointsMaterial);
  }

  export class LineSegments {
    rotation: Euler;
    constructor(geometry: BufferGeometry, material: LineBasicMaterial);
  }
}
