import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
// @ts-ignore
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import './App.css'

type Axis = 'x' | 'y' | 'z'
type Vec3 = [number, number, number]

type Pipe = {
  id: string
  start: Vec3 // grid units (1 unit = 10cm)
  axis: Axis
  lengthUnits: number // 2 => 20cm, 4 => 40cm
}

const UNIT = 0.1 // meter per grid unit (10cm)
const PIPE_RADIUS = 0.02 // 2cm radius
// 拖拽吸附已取消

function keyOf(v: Vec3): string {
  return `${v[0]},${v[1]},${v[2]}`
}

function addVec(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

function axisVec(axis: Axis, n: number): Vec3 {
  if (axis === 'x') return [n, 0, 0]
  if (axis === 'y') return [0, n, 0]
  return [0, 0, n]
}

function roundToGridUnits(v: Vec3): Vec3 {
  return [Math.round(v[0]), Math.round(v[1]), Math.round(v[2])]
}

function metersToUnits(v: THREE.Vector3): Vec3 {
  return [v.x / UNIT, v.y / UNIT, v.z / UNIT]
}

function unitsToMeters(v: Vec3): THREE.Vector3 {
  return new THREE.Vector3(v[0] * UNIT, v[1] * UNIT, v[2] * UNIT)
}

function App() {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const raycaster = useMemo(() => new THREE.Raycaster(), [])
  const mouse = useMemo(() => new THREE.Vector2(), [])

  const [pipes, setPipes] = useState<Pipe[]>([])
  const [selectedPipeId, setSelectedPipeId] = useState<string | null>(null)
  const [placing, setPlacing] = useState<null | { lengthUnits: number }>(null)
  const [placingStartUnits, setPlacingStartUnits] = useState<Vec3 | null>(null)
  const [currentDir, setCurrentDir] = useState<{ axis: Axis; sign: 1 | -1 }>({ axis: 'x', sign: 1 })
  const [availableDirs, setAvailableDirs] = useState<Array<{ axis: Axis; sign: 1 | -1 }>>([])
  // 交互增强：可选建造平面与层高（单位为格：10cm）
  const [planeMode] = useState<'XY' | 'XZ' | 'YZ'>('XY')
  const [planeLevelUnits] = useState<number>(0)
  // 一键生成结构：用户输入可用管线根数
  const [genCount20, setGenCount20] = useState<number>(0)
  const [genCount40, setGenCount40] = useState<number>(0)
  const [showGenModal, setShowGenModal] = useState<boolean>(false)

  // Build node degree map
  const nodeDegrees = useMemo(() => {
    const deg = new Map<string, number>()
    const inc = (k: string) => deg.set(k, (deg.get(k) || 0) + 1)
    for (const p of pipes) {
      const end = addVec(p.start, axisVec(p.axis, p.lengthUnits))
      inc(keyOf(p.start))
      inc(keyOf(end))
    }
    // Seed an origin anchor so user can start from (0,0,0)
    const originKey = keyOf([0, 0, 0] as Vec3)
    if (!deg.has(originKey)) deg.set(originKey, 0)
    return deg
  }, [pipes])

  const connectorCounts = useMemo(() => {
    let two = 0, three = 0, four = 0
    for (const [, d] of nodeDegrees) {
      if (d === 2) two++
      else if (d === 3) three++
      else if (d >= 4) four++
    }
    return { two, three, four }
  }, [nodeDegrees])

  const partsCounts = useMemo(() => {
    const two0 = pipes.filter(p => p.lengthUnits === 2).length
    const four0 = pipes.filter(p => p.lengthUnits === 4).length
    return { pipe20cm: two0, pipe40cm: four0, connectors2: connectorCounts.two, connectors3: connectorCounts.three, connectors4: connectorCounts.four }
  }, [pipes, connectorCounts])

  // Helper to list existing node positions in units
  const existingNodesUnits = useMemo<Vec3[]>(() => {
    const set = new Set<string>()
    for (const p of pipes) {
      set.add(keyOf(p.start))
      set.add(keyOf(addVec(p.start, axisVec(p.axis, p.lengthUnits))))
    }
    return Array.from(set).map(s => s.split(',').map(Number) as Vec3)
  }, [pipes])

  // Initialize Three.js scene
  useEffect(() => {
    const mount = mountRef.current!
    const w = mount.clientWidth
    const h = mount.clientHeight

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0xf4f7fb)
    const camera = new THREE.PerspectiveCamera(60, w / h, 0.01, 100)
    camera.position.set(1.2, 1.2, 1.2)
    cameraRef.current = camera

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
    mount.appendChild(renderer.domElement)
    rendererRef.current = renderer

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.target.set(0, 0, 0)
    controlsRef.current = controls

    const ambient = new THREE.AmbientLight(0xffffff, 0.9)
    scene.add(ambient)
    const dir = new THREE.DirectionalLight(0xffffff, 0.6)
    dir.position.set(2, 3, 2)
    scene.add(dir)

    // 基础网格：默认显示 XY 平面网格（z=0），用于参考
    const grid = new THREE.GridHelper(4, 40, 0x999999, 0xdddddd)
    grid.rotation.x = 0
    scene.add(grid)

    const axes = new THREE.AxesHelper(0.5)
    scene.add(axes)

    sceneRef.current = scene

    const onResize = () => {
      const w2 = mount.clientWidth
      const h2 = mount.clientHeight
      renderer.setSize(w2, h2)
      camera.aspect = w2 / h2
      camera.updateProjectionMatrix()
    }
    window.addEventListener('resize', onResize)

    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      controls.update()
      renderer.render(scene, camera)
    }
    tick()

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      controls.dispose()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
    }
  }, [])

  // Render pipes and connectors meshes whenever state changes
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return

    // Remove old dynamic meshes
    const toRemove = scene.children.filter((ch: THREE.Object3D) => !((ch as any).isGridHelper || (ch as any).isAxesHelper || (ch as any).isLight))
    toRemove.forEach((ch: THREE.Object3D) => scene.remove(ch))

    // Draw existing pipes
    for (const p of pipes) {
      const lengthMeters = p.lengthUnits * UNIT
      const geometry = new THREE.CylinderGeometry(PIPE_RADIUS, PIPE_RADIUS, lengthMeters, 16)
      const material = new THREE.MeshStandardMaterial({ color: 0x2c7be5 })
      const mesh = new THREE.Mesh(geometry, material)
      mesh.userData.pipeId = p.id
      mesh.name = `pipe-${p.id}`

      const startPos = unitsToMeters(p.start)
      const endUnits = addVec(p.start, axisVec(p.axis, p.lengthUnits))
      const endPos = unitsToMeters(endUnits)
      const center = new THREE.Vector3().addVectors(startPos, endPos).multiplyScalar(0.5)
      mesh.position.copy(center)

      const dir = new THREE.Vector3().subVectors(endPos, startPos).normalize()
      const up = new THREE.Vector3(0, 1, 0)
      const quat = new THREE.Quaternion().setFromUnitVectors(up, dir)
      mesh.quaternion.copy(quat)

      scene.add(mesh)
    }

    // Draw connectors/anchors：所有节点都显示锚点；度数不同颜色不同
    for (const [key, degree] of nodeDegrees.entries()) {
      const posUnits = key.split(',').map(Number) as Vec3
      const pos = unitsToMeters(posUnits)
      const color = degree >= 4 ? 0xdc3545 : degree === 3 ? 0xffc107 : degree === 2 ? 0x28a745 : 0x9aa5b1
      const size = degree >= 2 ? PIPE_RADIUS * 1.2 : PIPE_RADIUS * 0.9
      const geom = new THREE.SphereGeometry(size, 16, 16)
      const mat = new THREE.MeshStandardMaterial({ color, transparent: degree < 2, opacity: degree < 2 ? 0.9 : 1 })
      const sphere = new THREE.Mesh(geom, mat)
      sphere.position.copy(pos)
      sphere.name = `anchor-${degree}`
      sphere.userData.units = posUnits
      scene.add(sphere)
    }

    // Draw ghost pipe during placement：仅在选择了连接点与方向后显示
    if (placing && placingStartUnits) {
      const start = placingStartUnits
      const end = addVec(start, axisVec(currentDir.axis, placing.lengthUnits * currentDir.sign))
      const startPos = unitsToMeters(start)
      const endPos = unitsToMeters(end)
      const lengthMeters = placing.lengthUnits * UNIT
      const geom = new THREE.CylinderGeometry(PIPE_RADIUS * 0.95, PIPE_RADIUS * 0.95, lengthMeters, 16)
      const mat = new THREE.MeshStandardMaterial({ color: 0x6c757d, transparent: true, opacity: 0.6 })
      const ghost = new THREE.Mesh(geom, mat)
      const center = new THREE.Vector3().addVectors(startPos, endPos).multiplyScalar(0.5)
      ghost.position.copy(center)
      const dir = new THREE.Vector3().subVectors(endPos, startPos).normalize()
      const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
      ghost.quaternion.copy(quat)
      ghost.name = 'ghost'
      scene.add(ghost)
    }
  }, [pipes, placing, placingStartUnits, nodeDegrees, currentDir])

  // Pointer handling for placement and selection
  useEffect(() => {
    const mount = mountRef.current
    const scene = sceneRef.current
    const camera = cameraRef.current
    const renderer = rendererRef.current
    if (!mount || !scene || !camera || !renderer) return

    // 根据面与层高构造拾取平面
    const makePlane = (): THREE.Plane => {
      if (planeMode === 'XY') return new THREE.Plane(new THREE.Vector3(0, 0, 1), -planeLevelUnits * UNIT)
      if (planeMode === 'XZ') return new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeLevelUnits * UNIT)
      return new THREE.Plane(new THREE.Vector3(1, 0, 0), -planeLevelUnits * UNIT)
    }

    const onMouseMove = (e: MouseEvent) => {
      const rect = (renderer.domElement as HTMLCanvasElement).getBoundingClientRect()
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(mouse, camera)

      // 取消拖拽：移动时不进行管线起点/方向推断，仅保持选择拾取
    }

    const onClick = (e: MouseEvent) => {
      const rect = (renderer.domElement as HTMLCanvasElement).getBoundingClientRect()
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(mouse, camera)

      // 优先处理连接点点击：开始放置并计算可用方向
      const intersects = raycaster.intersectObjects(scene.children, false)
      const hitAnchor = intersects.find((i: THREE.Intersection) => i.object.name.startsWith('anchor-'))
      if (hitAnchor) {
        const units = (hitAnchor.object.userData.units as Vec3) || roundToGridUnits(metersToUnits(hitAnchor.object.position as THREE.Vector3))
        setPlacingStartUnits(units)
        if (!placing) setPlacing({ lengthUnits: 2 })

        // 计算该连接点已有占用方向
        const k = keyOf(units)
        const occupied = new Set<string>()
        for (const p of pipes) {
          const s = keyOf(p.start)
          const eUnits = addVec(p.start, axisVec(p.axis, p.lengthUnits))
          const e = keyOf(eUnits)
          if (s === k) occupied.add(`${p.axis}+`)
          else if (e === k) occupied.add(`${p.axis}-`)
        }
        const allDirs: Array<{ axis: Axis; sign: 1 | -1 }> = [
          { axis: 'x', sign: 1 }, { axis: 'x', sign: -1 },
          { axis: 'y', sign: 1 }, { axis: 'y', sign: -1 },
          { axis: 'z', sign: 1 }, { axis: 'z', sign: -1 },
        ]
        const dirs = allDirs.filter(d => !occupied.has(`${d.axis}${d.sign === 1 ? '+' : '-'}`))
        setAvailableDirs(dirs)
        if (dirs.length > 0) setCurrentDir(dirs[0])
        setSelectedPipeId(null)
        return
      }

      // 如果正在放置且已有起点：本次点击视为确认
      if (placing && placingStartUnits) {
        const startNorm: Vec3 = currentDir.sign === 1 ? placingStartUnits : addVec(placingStartUnits, axisVec(currentDir.axis, -placing.lengthUnits))
        const newPipe: Pipe = { id: crypto.randomUUID(), start: startNorm, axis: currentDir.axis, lengthUnits: placing.lengthUnits }
        setPipes(prev => {
          const end = addVec(newPipe.start, axisVec(newPipe.axis, newPipe.lengthUnits))
          const exists = prev.some(p => keyOf(p.start) === keyOf(newPipe.start) && keyOf(addVec(p.start, axisVec(p.axis, p.lengthUnits))) === keyOf(end))
          return exists ? prev : [...prev, newPipe]
        })
        setPlacing(null)
        setPlacingStartUnits(null)
        return
      }
      // 选择管段（非放置模式）
      const hitPipe = intersects.find((i: THREE.Intersection) => i.object.name.startsWith('pipe-'))
      if (hitPipe) {
        const id = hitPipe.object.userData.pipeId as string
        setSelectedPipeId(id)
      } else {
        setSelectedPipeId(null)
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'r' && availableDirs.length > 0) {
        const idx = availableDirs.findIndex(d => d.axis === currentDir.axis && d.sign === currentDir.sign)
        const next = availableDirs[(idx + 1) % availableDirs.length]
        setCurrentDir(next)
      }
      if (e.key === 'Enter' && placing && placingStartUnits) {
        const startNorm: Vec3 = currentDir.sign === 1 ? placingStartUnits : addVec(placingStartUnits, axisVec(currentDir.axis, -placing.lengthUnits))
        const newPipe: Pipe = { id: crypto.randomUUID(), start: startNorm, axis: currentDir.axis, lengthUnits: placing.lengthUnits }
        setPipes(prev => {
          const end = addVec(newPipe.start, axisVec(newPipe.axis, newPipe.lengthUnits))
          const exists = prev.some(p => keyOf(p.start) === keyOf(newPipe.start) && keyOf(addVec(p.start, axisVec(p.axis, p.lengthUnits))) === keyOf(end))
          return exists ? prev : [...prev, newPipe]
        })
        setPlacing(null)
        setPlacingStartUnits(null)
      }
      if (e.key === 'Escape') { setPlacing(null); setPlacingStartUnits(null) }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedPipeId) {
          setPipes(prev => prev.filter(p => p.id !== selectedPipeId))
          setSelectedPipeId(null)
        }
      }
    }

    renderer.domElement.addEventListener('mousemove', onMouseMove)
    renderer.domElement.addEventListener('click', onClick)
    window.addEventListener('keydown', onKeyDown)

    return () => {
      renderer.domElement.removeEventListener('mousemove', onMouseMove)
      renderer.domElement.removeEventListener('click', onClick)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [placing, placingStartUnits, existingNodesUnits, selectedPipeId, planeMode, planeLevelUnits, currentDir, availableDirs])

  // 工具栏按钮：循环方向与确认
  const cycleDirection = () => {
    if (availableDirs.length === 0) return
    const idx = availableDirs.findIndex(d => d.axis === currentDir.axis && d.sign === currentDir.sign)
    const next = availableDirs[(idx + 1) % availableDirs.length]
    setCurrentDir(next)
  }
  const confirmPlace = () => {
    if (!(placing && placingStartUnits)) return
    const startNorm: Vec3 = currentDir.sign === 1 ? placingStartUnits : addVec(placingStartUnits, axisVec(currentDir.axis, -placing.lengthUnits))
    const newPipe: Pipe = { id: crypto.randomUUID(), start: startNorm, axis: currentDir.axis, lengthUnits: placing.lengthUnits }
    setPipes(prev => {
      const end = addVec(newPipe.start, axisVec(newPipe.axis, newPipe.lengthUnits))
      const exists = prev.some(p => keyOf(p.start) === keyOf(newPipe.start) && keyOf(addVec(p.start, axisVec(p.axis, p.lengthUnits))) === keyOf(end))
      return exists ? prev : [...prev, newPipe]
    })
    setPlacing(null)
    setPlacingStartUnits(null)
  }

  // 按可用数量生成尽可能多的完整矩形体（立方框架）
  const buildStructureByCounts = (count20: number, count40: number): Pipe[] => {
    const step = 4 // 40cm 边长
    const edgeCapacity = count40 + Math.floor(count20 / 2) // 一个边可用1根40cm或2根20cm
    const boxes = Math.floor(edgeCapacity / 12) // 每个立方框架需要12条边
    if (boxes <= 0) return []

    // 本次生成将优先使用40cm管，余下的边用两段20cm拼接
    const edgesNeeded = boxes * 12
    let edges40 = Math.min(count40, edgesNeeded)
    let edgePairs20 = edgesNeeded - edges40 // 每条边需要2根20cm
    let remaining20 = count20

    const pipesOut: Pipe[] = []

    const useEdge = (start: Vec3, axis: Axis) => {
      if (edges40 > 0) {
        pipesOut.push({ id: crypto.randomUUID(), start, axis, lengthUnits: step })
        edges40--
      } else if (edgePairs20 > 0 && remaining20 >= 2) {
        // 两段20cm拼接为一条边
        const dir = axisVec(axis, 2)
        pipesOut.push({ id: crypto.randomUUID(), start, axis, lengthUnits: 2 })
        pipesOut.push({ id: crypto.randomUUID(), start: addVec(start, dir), axis, lengthUnits: 2 })
        edgePairs20--
        remaining20 -= 2
      }
    }

    // 将多个框架均匀排布为近似立方阵列，避免重叠
    const nx = Math.max(1, Math.ceil(Math.cbrt(boxes)))
    const ny = nx
    const nz = Math.max(1, Math.ceil(boxes / (nx * ny)))
    const sep = step * 2 // 框架之间留空避免共享边

    let b = 0
    for (let k = 0; k < nz && b < boxes; k++) {
      for (let j = 0; j < ny && b < boxes; j++) {
        for (let i = 0; i < nx && b < boxes; i++) {
          const x0 = i * sep
          const y0 = j * sep
          const z0 = k * sep
          // 底面矩形（z0）
          useEdge([x0, y0, z0], 'x')
          useEdge([x0, y0 + step, z0], 'x')
          useEdge([x0, y0, z0], 'y')
          useEdge([x0 + step, y0, z0], 'y')
          // 顶面矩形（z0+step）
          useEdge([x0, y0, z0 + step], 'x')
          useEdge([x0, y0 + step, z0 + step], 'x')
          useEdge([x0, y0, z0 + step], 'y')
          useEdge([x0 + step, y0, z0 + step], 'y')
          // 四个立柱
          useEdge([x0, y0, z0], 'z')
          useEdge([x0 + step, y0, z0], 'z')
          useEdge([x0, y0 + step, z0], 'z')
          useEdge([x0 + step, y0 + step, z0], 'z')
          b++
        }
      }
    }

    return pipesOut
  }

  // 分层不规则爬爬架生成器：不同层大小与偏移，外围框架 + 中线加强
  const buildTieredScaffold = (): Pipe[] => {
    const step = 4 // 40cm
    const tiers = [
      { x0: 0, y0: 0, z: 0, Nx: 7, Ny: 6 },
      { x0: step, y0: step, z: step * 2, Nx: 5, Ny: 4 },
      { x0: step * 2, y0: step, z: step * 4, Nx: 3, Ny: 3 },
    ]
    const out: Pipe[] = []
    const add = (start: Vec3, axis: Axis) => out.push({ id: crypto.randomUUID(), start, axis, lengthUnits: step })

    const addFrame = (t: { x0: number; y0: number; z: number; Nx: number; Ny: number }) => {
      const { x0, y0, z, Nx, Ny } = t
      // 四边外围框架（X方向上下边）
      for (let x = 0; x < Nx - 1; x++) add([x0 + x * step, y0 + 0, z], 'x')
      for (let x = 0; x < Nx - 1; x++) add([x0 + x * step, y0 + (Ny - 1) * step, z], 'x')
      // 左右边（Y方向）
      for (let y = 0; y < Ny - 1; y++) add([x0 + 0, y0 + y * step, z], 'y')
      for (let y = 0; y < Ny - 1; y++) add([x0 + (Nx - 1) * step, y0 + y * step, z], 'y')
      // 中线加强（一条竖向与一条横向）
      const midX = Math.floor((Nx - 1) / 2)
      const midY = Math.floor((Ny - 1) / 2)
      for (let y = 0; y < Ny - 1; y++) add([x0 + midX * step, y0 + y * step, z], 'y')
      for (let x = 0; x < Nx - 1; x++) add([x0 + x * step, y0 + midY * step, z], 'x')
    }

    // 逐层添加框架
    tiers.forEach(addFrame)

    // 选择性立柱：底层的若干角与中点，贯穿至最高层
    const base = tiers[0]
    const topZ = tiers[tiers.length - 1].z + step
    const cols: Array<[number, number]> = [
      [base.x0 + 0, base.y0 + 0],
      [base.x0 + (base.Nx - 1) * step, base.y0 + 0],
      [base.x0 + 0, base.y0 + (base.Ny - 1) * step],
      [base.x0 + (base.Nx - 1) * step, base.y0 + (base.Ny - 1) * step],
      [base.x0 + Math.floor((base.Nx - 1) / 2) * step, base.y0 + 0],
      [base.x0 + 0, base.y0 + Math.floor((base.Ny - 1) / 2) * step],
    ]
    for (const [cx, cy] of cols) {
      for (let z = 0; z < topZ; z += step) add([cx, cy, z], 'z')
    }

    return out
  }

  // 取消自动初始化：保留原点锚点，用户可手动生成分层结构

  const downloadSnapshot = useCallback(() => {
    const r = rendererRef.current
    if (!r) return
    const canvas3d = r.domElement as HTMLCanvasElement
    const w = canvas3d.width
    const h = canvas3d.height

    const out = document.createElement('canvas')
    out.width = w
    out.height = h
    const ctx = out.getContext('2d')
    if (!ctx) return

    const img = new Image()
    img.onload = () => {
      ctx.drawImage(img, 0, 0)

      // Title bar
      const titleBarHeight = 60
      ctx.fillStyle = 'rgba(255,255,255,0.9)'
      ctx.fillRect(0, 0, w, titleBarHeight)
      ctx.fillStyle = '#111827'
      ctx.font = 'bold 28px system-ui, Arial, "Microsoft YaHei"'
      ctx.textBaseline = 'middle'
      ctx.fillText('宇宙爬爬架3D模拟器', 20, titleBarHeight / 2)

      // Parts counts panel
      const panelPadding = 16
      const panelWidth = 300
      const panelHeight = 170
      const panelX = w - panelWidth - panelPadding
      const panelY = titleBarHeight + panelPadding
      ctx.fillStyle = 'rgba(255,255,255,0.92)'
      ctx.fillRect(panelX, panelY, panelWidth, panelHeight)
      ctx.strokeStyle = 'rgba(0,0,0,0.08)'
      ctx.lineWidth = 1
      ctx.strokeRect(panelX, panelY, panelWidth, panelHeight)
      ctx.fillStyle = '#111827'
      ctx.font = '16px system-ui, Arial, "Microsoft YaHei"'
      let tx = panelX + 12
      let ty = panelY + 28
      ctx.fillText(`20cm管：${partsCounts.pipe20cm}`, tx, ty); ty += 22
      ctx.fillText(`40cm管：${partsCounts.pipe40cm}`, tx, ty); ty += 22
      ctx.fillText(`二通连接件：${partsCounts.connectors2}`, tx, ty); ty += 22
      ctx.fillText(`三通连接件：${partsCounts.connectors3}`, tx, ty); ty += 22
      ctx.fillText(`四通连接件：${partsCounts.connectors4}`, tx, ty)
      ctx.fillStyle = '#6b7280'
      ctx.font = '12px system-ui, Arial, "Microsoft YaHei"'
      const ts = new Date().toLocaleString()
      ctx.fillText(ts, tx, panelY + panelHeight - 10)

      out.toBlob((blob) => {
        if (!blob) return
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        const fname = `宇宙爬爬架3D模拟器-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
        a.href = url
        a.download = fname
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
      }, 'image/png')
    }
    img.src = canvas3d.toDataURL('image/png')
  }, [partsCounts])

  return (
    <div className="app-root">
      <div className="canvas-wrap" ref={mountRef} />

      <div className="header-container">
        <div className="title-banner">宇宙爬爬架3D模拟器</div>
        <div className="title-authors">
          <div>程序开发：宇宙爸爸</div>
          <div>产品经理：宇宙妈妈</div>
          <div>实习生：小宇宙</div>
        </div>
      </div>

      <div className="counts">
        <div>20cm管 <span>{partsCounts.pipe20cm}</span></div>
        <div>40cm管 <span>{partsCounts.pipe40cm}</span></div>
        <div>二通连接件 <span>{partsCounts.connectors2}</span></div>
        <div>三通连接件 <span>{partsCounts.connectors3}</span></div>
        <div>四通连接件 <span>{partsCounts.connectors4}</span></div>
      </div>

      <div className="toolbar">
        <button className={placing?.lengthUnits === 2 ? 'active' : ''} onClick={() => setPlacing({ lengthUnits: 2 })}>添加20cm管</button>
        <button className={placing?.lengthUnits === 4 ? 'active' : ''} onClick={() => setPlacing({ lengthUnits: 4 })}>添加40cm管</button>
        <span className="sep" />
        <span className="hint">方向：</span>
        <button onClick={cycleDirection} disabled={availableDirs.length === 0}>切换 (R)</button>
        <span style={{ width: '40px', textAlign: 'center', fontWeight: 'bold', color: '#3b82f6' }}>
          {placingStartUnits ? `${currentDir.axis.toUpperCase()}${currentDir.sign === 1 ? '+' : '-'}` : '-'}
        </span>
        <button onClick={confirmPlace} disabled={!(placing && placingStartUnits)} className={placing && placingStartUnits ? 'active' : ''}>确认放置</button>
        <span className="sep" />
        <button onClick={downloadSnapshot}>一键截图</button>
        <span className="sep" />
        <button onClick={() => setShowGenModal(true)}>一键生成</button>
        <span className="hint">Esc 取消 / Del 删除</span>
      </div>

      {showGenModal && (
        <div className="modal-overlay" onClick={() => setShowGenModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">一键生成结构</div>
            <div className="modal-body">
              <div className="modal-row">
                <label>20cm 管线根数</label>
                <input type="number" min={0} value={genCount20} onChange={e => setGenCount20(Math.max(0, Number(e.target.value) || 0))} />
              </div>
              <div className="modal-row">
                <label>40cm 管线根数</label>
                <input type="number" min={0} value={genCount40} onChange={e => setGenCount40(Math.max(0, Number(e.target.value) || 0))} />
              </div>
              <div className="modal-actions">
                <button onClick={() => { const s = buildStructureByCounts(genCount20, genCount40); setPipes(s); setPlacing(null); setPlacingStartUnits(null); setShowGenModal(false); }}>开始生成</button>
                <button onClick={() => setShowGenModal(false)}>取消</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
