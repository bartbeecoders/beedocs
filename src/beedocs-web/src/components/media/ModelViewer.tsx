import { useCallback, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { withApiBase } from '../../basePath'
import {
  detectModelFormat,
  filenameFromPath,
  type Model3dFormat,
} from '../../media/mediaKinds'

export type ModelViewerProps = {
  url: string
  title?: string
  format?: Model3dFormat | string
  className?: string
}

function resolveModelUrl(url: string): string {
  if (!url) return url
  if (
    /^https?:\/\//i.test(url) ||
    url.startsWith('//') ||
    url.startsWith('blob:') ||
    url.startsWith('data:')
  ) {
    return url
  }
  const path = url.startsWith('/') ? url : `/${url}`
  return withApiBase(path)
}

function cssColor(el: Element, name: string, fallback: string): THREE.Color {
  const raw = getComputedStyle(el).getPropertyValue(name).trim()
  if (!raw) return new THREE.Color(fallback)
  try {
    return new THREE.Color(raw)
  } catch {
    return new THREE.Color(fallback)
  }
}

function disposeObject3D(root: THREE.Object3D) {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    const mat = mesh.material
    if (!mat) return
    const materials = Array.isArray(mat) ? mat : [mat]
    for (const m of materials) {
      // Dispose common texture maps if present
      const anyMat = m as THREE.MeshStandardMaterial
      for (const key of [
        'map',
        'normalMap',
        'roughnessMap',
        'metalnessMap',
        'aoMap',
        'emissiveMap',
        'bumpMap',
        'displacementMap',
        'alphaMap',
        'envMap',
      ] as const) {
        const tex = anyMat[key]
        if (tex && typeof (tex as THREE.Texture).dispose === 'function') {
          ;(tex as THREE.Texture).dispose()
        }
      }
      m.dispose()
    }
  })
}

function fitCameraToObject(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  object: THREE.Object3D,
) {
  const box = new THREE.Box3().setFromObject(object)
  if (box.isEmpty()) {
    camera.position.set(2, 1.5, 3)
    controls.target.set(0, 0, 0)
    controls.update()
    return
  }

  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z, 0.001)
  const fov = (camera.fov * Math.PI) / 180
  const fitDist = (maxDim / 2) / Math.tan(fov / 2)
  const distance = fitDist * 1.55

  // Slightly elevated three-quarter view
  const dir = new THREE.Vector3(0.72, 0.48, 0.85).normalize()
  camera.position.copy(center).addScaledVector(dir, distance)
  camera.near = Math.max(distance / 200, 0.01)
  camera.far = Math.max(distance * 40, 100)
  camera.updateProjectionMatrix()

  controls.target.copy(center)
  controls.minDistance = maxDim * 0.15
  controls.maxDistance = maxDim * 12
  controls.update()
}

function setWireframe(root: THREE.Object3D, enabled: boolean) {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh || !mesh.material) return
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const m of materials) {
      if ('wireframe' in m) {
        ;(m as THREE.MeshBasicMaterial).wireframe = enabled
      }
    }
  })
}

/**
 * Three.js GLB/GLTF/OBJ viewer with orbit controls, auto-fit, and clean disposal.
 */
export function ModelViewer({ url, title, format, className }: ModelViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasHostRef = useRef<HTMLDivElement>(null)

  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    controls: OrbitControls
    model: THREE.Object3D | null
    ground: THREE.Mesh | null
    envMap: THREE.Texture | null
    frame: number
    disposed: boolean
  } | null>(null)

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [wireframe, setWireframeState] = useState(false)
  const [autoRotate, setAutoRotate] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [hintFaded, setHintFaded] = useState(false)

  const resolved = resolveModelUrl(url)
  const displayName = title?.trim() || filenameFromPath(url) || '3D model'
  const resolvedFormat: Model3dFormat =
    detectModelFormat({ url, format }) ?? 'glb'

  const formatLabel = resolvedFormat.toUpperCase()

  // Keep toolbar toggles in sync with live scene
  useEffect(() => {
    const s = sceneRef.current
    if (!s?.controls) return
    s.controls.autoRotate = autoRotate
  }, [autoRotate])

  useEffect(() => {
    const s = sceneRef.current
    if (!s?.model) return
    setWireframe(s.model, wireframe)
  }, [wireframe])

  const resetView = useCallback(() => {
    const s = sceneRef.current
    if (!s?.model) return
    fitCameraToObject(s.camera, s.controls, s.model)
  }, [])

  const toggleFullscreen = useCallback(() => {
    setFullscreen((v) => !v)
  }, [])

  // Escape exits immersive mode
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen])

  // Trigger a canvas resize when entering/leaving immersive mode
  useEffect(() => {
    const s = sceneRef.current
    const host = canvasHostRef.current
    if (!s || !host) return
    const w = host.clientWidth || 1
    const h = host.clientHeight || 1
    s.camera.aspect = w / h
    s.camera.updateProjectionMatrix()
    s.renderer.setSize(w, h, false)
  }, [fullscreen])

  useEffect(() => {
    const host = canvasHostRef.current
    if (!host) return

    let cancelled = false
    setStatus('loading')
    setErrorMsg(null)
    setWireframeState(false)
    setHintFaded(false)

    // Studio palette — dark neutral stage (Sketchfab-like), not page cream
    const bg = new THREE.Color('#161513')
    const elev = new THREE.Color('#2a2722')
    const accent = cssColor(host, '--accent', '#c9920a')
    const gridMajor = new THREE.Color('#3a3630')
    const gridMinor = new THREE.Color('#2a2722')

    const scene = new THREE.Scene()
    scene.background = bg.clone()
    scene.fog = new THREE.Fog(bg.getHex(), 14, 42)

    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200)
    camera.position.set(2.4, 1.55, 3.1)

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.15
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    host.appendChild(renderer.domElement)
    renderer.domElement.className = 'model-viewer-canvas'
    renderer.domElement.setAttribute('role', 'img')
    renderer.domElement.setAttribute('aria-label', displayName)
    renderer.domElement.tabIndex = 0

    // Image-based lighting for PBR materials (Sketchfab/Figma-adjacent)
    const pmrem = new THREE.PMREMGenerator(renderer)
    const envScene = new RoomEnvironment()
    const envMap = pmrem.fromScene(envScene, 0.04).texture
    scene.environment = envMap
    pmrem.dispose()

    // Key + fill + soft ambient — brighter product-shot lighting
    const hemi = new THREE.HemisphereLight(0xfff6e8, 0x1a1814, 0.55)
    scene.add(hemi)

    const ambient = new THREE.AmbientLight(0xffffff, 0.22)
    scene.add(ambient)

    const key = new THREE.DirectionalLight(0xfff4e5, 1.35)
    key.position.set(4.8, 7.5, 3.2)
    key.castShadow = true
    key.shadow.mapSize.set(1024, 1024)
    key.shadow.camera.near = 0.5
    key.shadow.camera.far = 40
    key.shadow.bias = -0.00025
    key.shadow.radius = 2
    scene.add(key)

    const fill = new THREE.DirectionalLight(accent.getHex(), 0.42)
    fill.position.set(-3.2, 2.4, -1.8)
    scene.add(fill)

    const rim = new THREE.DirectionalLight(0xdde8ff, 0.38)
    rim.position.set(-1.2, 3.5, -5.5)
    scene.add(rim)

    // Soft ground disk
    const groundGeo = new THREE.CircleGeometry(10, 64)
    const groundMat = new THREE.MeshStandardMaterial({
      color: elev,
      roughness: 0.94,
      metalness: 0.04,
      transparent: true,
      opacity: 0.72,
    })
    const ground = new THREE.Mesh(groundGeo, groundMat)
    ground.rotation.x = -Math.PI / 2
    ground.position.y = 0
    ground.receiveShadow = true
    scene.add(ground)

    // Subtle studio grid
    const grid = new THREE.GridHelper(14, 28, gridMajor.getHex(), gridMinor.getHex())
    grid.position.y = 0.002
    const gridMats = Array.isArray(grid.material) ? grid.material : [grid.material]
    for (const m of gridMats) {
      m.transparent = true
      m.opacity = 0.28
      m.depthWrite = false
    }
    scene.add(grid)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.07
    controls.enablePan = true
    controls.autoRotate = false
    controls.autoRotateSpeed = 1.1
    controls.screenSpacePanning = true
    controls.target.set(0, 0.35, 0)

    const state = {
      renderer,
      scene,
      camera,
      controls,
      model: null as THREE.Object3D | null,
      ground,
      envMap,
      frame: 0,
      disposed: false,
    }
    sceneRef.current = state

    const resize = () => {
      if (state.disposed) return
      const w = host.clientWidth || 1
      const h = host.clientHeight || 1
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h, false)
    }
    resize()

    const ro = new ResizeObserver(() => resize())
    ro.observe(host)

    const tick = () => {
      if (state.disposed) return
      state.frame = requestAnimationFrame(tick)
      controls.update()
      renderer.render(scene, camera)
    }
    tick()

    // Fade interaction hint after first input or timeout
    const fadeHint = () => setHintFaded(true)
    const hintTimer = window.setTimeout(fadeHint, 4200)
    const onUserInteract = () => {
      fadeHint()
      controls.removeEventListener('start', onUserInteract)
      renderer.domElement.removeEventListener('pointerdown', onUserInteract)
      renderer.domElement.removeEventListener('wheel', onUserInteract)
    }
    controls.addEventListener('start', onUserInteract)
    renderer.domElement.addEventListener('pointerdown', onUserInteract, { passive: true })
    renderer.domElement.addEventListener('wheel', onUserInteract, { passive: true })

    const onLoaded = (root: THREE.Object3D) => {
      if (cancelled || state.disposed) {
        disposeObject3D(root)
        return
      }
      // Center model on ground
      const box = new THREE.Box3().setFromObject(root)
      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())
      root.position.x -= center.x
      root.position.z -= center.z
      root.position.y -= box.min.y

      root.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.castShadow = true
        mesh.receiveShadow = true
        // Lift flat OBJ defaults toward PBR so IBL reads correctly
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (let i = 0; i < mats.length; i++) {
          const m = mats[i]
          if (!m) continue
          if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
            const sm = m as THREE.MeshStandardMaterial
            if (sm.roughness > 0.95) sm.roughness = 0.55
            if (sm.metalness < 0.02) sm.metalness = 0.08
            sm.envMapIntensity = 0.95
            sm.needsUpdate = true
          } else if ((m as THREE.MeshPhongMaterial).isMeshPhongMaterial || m.type === 'MeshBasicMaterial') {
            const color = (m as THREE.MeshPhongMaterial).color?.clone?.() ?? new THREE.Color(0xb0b0b0)
            const std = new THREE.MeshStandardMaterial({
              color,
              roughness: 0.48,
              metalness: 0.12,
              envMapIntensity: 1,
            })
            if (Array.isArray(mesh.material)) mesh.material[i] = std
            else mesh.material = std
            m.dispose()
          }
        }
      })

      scene.add(root)
      state.model = root

      // Scale ground to model footprint
      const footprint = Math.max(size.x, size.z, 0.5)
      ground.scale.setScalar(Math.max(footprint * 0.38, 0.45))
      grid.scale.setScalar(Math.max(footprint * 0.14, 0.55))

      fitCameraToObject(camera, controls, root)
      setStatus('ready')
    }

    const onError = (err: unknown) => {
      if (cancelled || state.disposed) return
      console.error('[ModelViewer] load failed', err)
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load 3D model')
      setStatus('error')
    }

    const loadUrl = resolved
    if (resolvedFormat === 'obj') {
      const loader = new OBJLoader()
      loader.load(loadUrl, onLoaded, undefined, onError)
    } else {
      const loader = new GLTFLoader()
      loader.load(
        loadUrl,
        (gltf) => onLoaded(gltf.scene),
        undefined,
        onError,
      )
    }

    return () => {
      cancelled = true
      state.disposed = true
      window.clearTimeout(hintTimer)
      controls.removeEventListener('start', onUserInteract)
      renderer.domElement.removeEventListener('pointerdown', onUserInteract)
      renderer.domElement.removeEventListener('wheel', onUserInteract)
      cancelAnimationFrame(state.frame)
      ro.disconnect()
      controls.dispose()
      if (state.model) {
        scene.remove(state.model)
        disposeObject3D(state.model)
        state.model = null
      }
      scene.remove(ground)
      disposeObject3D(ground)
      scene.remove(grid)
      disposeObject3D(grid)
      if (state.envMap) state.envMap.dispose()
      scene.environment = null
      renderer.dispose()
      if (typeof renderer.forceContextLoss === 'function') {
        renderer.forceContextLoss()
      }
      if (renderer.domElement.parentElement === host) {
        host.removeChild(renderer.domElement)
      }
      sceneRef.current = null
    }
    // displayName is only used for the canvas aria-label at setup time
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when asset changes
  }, [resolved, resolvedFormat])

  return (
    <figure
      ref={hostRef}
      className={[
        'media-embed',
        'media-embed--model',
        fullscreen ? 'is-fullscreen' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label={displayName}
    >
      <header className="media-embed-chrome">
        <div className="media-embed-chrome-left">
          <span className="media-embed-badge media-embed-badge--model" title="3D model">
            {formatLabel}
          </span>
          <span className="media-embed-title" title={displayName}>
            {displayName}
          </span>
        </div>
        <div className="media-embed-chrome-actions" role="toolbar" aria-label="3D model controls">
          <button
            type="button"
            className="btn sm ghost media-embed-action"
            onClick={resetView}
            disabled={status !== 'ready'}
            title="Reset camera"
            aria-label="Reset camera view"
          >
            <ResetIcon />
            <span className="media-embed-action-label">Reset</span>
          </button>
          <button
            type="button"
            className={`btn sm ghost media-embed-action${wireframe ? ' is-active' : ''}`}
            onClick={() => setWireframeState((v) => !v)}
            disabled={status !== 'ready'}
            title="Toggle wireframe"
            aria-pressed={wireframe}
            aria-label="Toggle wireframe"
          >
            <WireframeIcon />
            <span className="media-embed-action-label">Wire</span>
          </button>
          <button
            type="button"
            className={`btn sm ghost media-embed-action${autoRotate ? ' is-active' : ''}`}
            onClick={() => setAutoRotate((v) => !v)}
            disabled={status !== 'ready'}
            title="Toggle auto-rotate"
            aria-pressed={autoRotate}
            aria-label="Toggle auto-rotate"
          >
            <RotateIcon />
            <span className="media-embed-action-label">Spin</span>
          </button>
          <button
            type="button"
            className={`btn sm ghost media-embed-action${fullscreen ? ' is-active' : ''}`}
            onClick={toggleFullscreen}
            title={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
            aria-pressed={fullscreen}
            aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          >
            <FullscreenIcon expanded={fullscreen} />
            <span className="media-embed-action-label">{fullscreen ? 'Exit' : 'Full'}</span>
          </button>
          <a
            className="btn sm ghost media-embed-action"
            href={resolved}
            target="_blank"
            rel="noopener noreferrer"
            download={displayName}
            title="Download model"
            aria-label="Download 3D model"
          >
            <DownloadIcon />
            <span className="media-embed-action-label">Download</span>
          </a>
        </div>
      </header>

      <div className="media-embed-body media-embed-body--model">
        <div ref={canvasHostRef} className="model-viewer-stage" />
        {status === 'loading' && (
          <div className="media-embed-status" role="status" aria-live="polite">
            <span className="media-embed-spinner" aria-hidden />
            <span>Loading model…</span>
          </div>
        )}
        {status === 'error' && (
          <div className="media-embed-status media-embed-status--error" role="alert">
            <span>{errorMsg || 'Could not load this 3D model.'}</span>
            <a className="btn sm" href={resolved} target="_blank" rel="noopener noreferrer">
              Open file
            </a>
          </div>
        )}
        {status === 'ready' && (
          <div
            className={['model-viewer-hint', hintFaded ? 'is-faded' : ''].filter(Boolean).join(' ')}
            aria-hidden
          >
            Drag to orbit · Scroll to zoom · Right-drag to pan
          </div>
        )}
      </div>
    </figure>
  )
}

function ResetIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 8a5 5 0 1 0 1.2-3.3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M3 3.5V7h3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function WireframeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 2 14 5.5v5L8 14 2 10.5v-5L8 2Z" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 2v12M2 5.5h12M2 10.5h12" stroke="currentColor" strokeWidth="1.1" opacity="0.7" />
    </svg>
  )
}

function RotateIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <ellipse cx="8" cy="8" rx="5.5" ry="2.4" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.5 8c0 2.5 2.5 4.5 5.5 4.5S13.5 10.5 13.5 8" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M12 10.2 13.6 8 15 10"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function FullscreenIcon({ expanded }: { expanded: boolean }) {
  if (expanded) {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path
          d="M5 3H3v2M11 3h2v2M5 13H3v-2M11 13h2v-2"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 2v8m0 0 3-3m-3 3L5 7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 12.5v.5A1.5 1.5 0 0 0 4.5 14.5h7a1.5 1.5 0 0 0 1.5-1.5v-.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}
