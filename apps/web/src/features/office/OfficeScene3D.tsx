'use client';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Html } from '@react-three/drei';
import { useLive } from '@/lib/live';
import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Color, Matrix4, Vector3, Quaternion, type Group, type InstancedMesh } from 'three';
import type { AgentStateDTO, OfficeLayout } from '@workforce/contracts';
import { officeSpatial, activityDestination, type Point } from './spatial';

function Box({ position, size, color }: { position: Point; size: Point; color: string }) {
  return (
    <mesh position={position}>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}
// One draw call for all repeated desk parts rather than hundreds of separate furniture meshes.
function Furniture({
  agents,
  positions,
  selected,
  visible,
  select,
}: {
  agents: AgentStateDTO[];
  positions: Map<string, Point>;
  selected: string | null;
  visible: Set<string>;
  select: (id: string) => void;
}) {
  const mesh = useRef<InstancedMesh>(null);
  const parts = useMemo(
    () =>
      agents.flatMap((a) => {
        const p = positions.get(a.employeeId)!;
        const active = a.expiresAt && Date.parse(a.expiresAt) > Date.now() && a.activity !== 'NONE';
        return [
          { offset: [0, 1, 0], size: [2.6, 0.14, 1.3], color: a.employeeId === selected ? '#d5ad63' : '#b99570' },
          { offset: [-1, 0.48, 0], size: [0.1, 1, 0.9], color: '#748078' },
          { offset: [1, 0.48, 0], size: [0.1, 1, 0.9], color: '#748078' },
          { offset: [0, 1.5, -0.3], size: [1.05, 0.7, 0.1], color: '#304841' },
          { offset: [0, 1.51, -0.23], size: [0.9, 0.55, 0.03], color: active ? '#84d4b9' : '#71877e' },
          { offset: [0, 1.1, 0.35], size: [0.8, 0.04, 0.3], color: '#e5ebe4' },
          { offset: [0, 0.55, 1.15], size: [0.65, 0.12, 0.65], color: '#425c53' },
          { offset: [0, 0.9, 1.5], size: [0.65, 0.6, 0.12], color: '#425c53' },
        ].map((part) => ({
          ...part,
          id: a.employeeId,
          position: part.offset.map((v, i) => v + p[i]) as Point,
          color: visible.has(a.employeeId) ? part.color : '#ccd4ce',
        }));
      }),
    [agents, positions, selected, visible],
  );
  useLayoutEffect(() => {
    if (!mesh.current) return;
    const matrix = new Matrix4();
    const q = new Quaternion();
    parts.forEach((p, i) => {
      matrix.compose(new Vector3(...p.position), q, new Vector3(...(p.size as Point)));
      mesh.current!.setMatrixAt(i, matrix);
      mesh.current!.setColorAt(i, new Color(p.color));
    });
    mesh.current.instanceMatrix.needsUpdate = true;
    if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true;
    mesh.current.computeBoundingSphere();
  }, [parts]);
  return (
    <instancedMesh
      ref={mesh}
      args={[undefined, undefined, parts.length]}
      onClick={(e) => {
        e.stopPropagation();
        const p = parts[e.instanceId ?? -1];
        if (p && visible.has(p.id)) select(p.id);
      }}
    >
      <boxGeometry />
      <meshStandardMaterial />
    </instancedMesh>
  );
}
function Employee({
  agent,
  desk,
  destination,
  color,
  selected,
  reduced,
  select,
  burst,
}: {
  agent: AgentStateDTO;
  desk: Point;
  destination: Point;
  color: string;
  selected: boolean;
  reduced: boolean;
  select: () => void;
  burst: Map<string, number>;
}) {
  const ref = useRef<Group>(null);
  const route = useRef<Vector3[]>([]);
  const last = useRef('');
  useFrame(({ clock }, delta) => {
    const g = ref.current;
    if (!g) return;
    const key = destination.join(',');
    if (last.current !== key) {
      last.current = key;
      const aisle = desk[0] + 1.65;
      route.current = [
        new Vector3(g.position.x, 0, g.position.z + 1),
        new Vector3(aisle, 0, g.position.z + 1),
        new Vector3(aisle, 0, destination[2]),
        new Vector3(...destination),
      ];
    }
    if (reduced) {
      g.position.set(...destination);
      route.current = [];
    } else if (route.current.length) {
      const target = route.current[0];
      const distance = g.position.distanceTo(target);
      if (distance < 0.08) route.current.shift();
      else {
        const next = g.position.clone().lerp(target, Math.min(1, (Math.min(delta, 0.1) * 5) / distance));
        g.rotation.y = Math.atan2(target.x - g.position.x, target.z - g.position.z);
        g.position.copy(next);
      }
    }
    g.position.y =
      !reduced && (burst.get(agent.employeeId) ?? 0) > performance.now()
        ? Math.abs(Math.sin(clock.elapsedTime * 6)) * 0.4
        : 0;
  });
  return (
    <group
      ref={ref}
      position={[desk[0], 0, desk[2] + 1]}
      onClick={(e) => {
        e.stopPropagation();
        select();
      }}
    >
      <mesh position={[0, 1, 0]}>
        <capsuleGeometry args={[0.23, 0.35, 4, 8]} />
        <meshStandardMaterial color={selected ? '#c29139' : color} />
      </mesh>
      <mesh position={[0, 1.55, 0]}>
        <sphereGeometry args={[0.23, 10, 8]} />
        <meshStandardMaterial color="#cda889" />
      </mesh>
      <Box position={[-0.13, 0.5, 0]} size={[0.17, 0.5, 0.2]} color="#3f514a" />
      <Box position={[0.13, 0.5, 0]} size={[0.17, 0.5, 0.2]} color="#3f514a" />
      {selected && (
        <Html position={[0, 2.25, 0]} center>
          <span className="office-nameplate">{agent.name}</span>
        </Html>
      )}
    </group>
  );
}
function RenderClock({ paused }: { paused: boolean }) {
  const invalidate = useThree((s) => s.invalidate);
  const setDpr = useThree((s) => s.setDpr);
  const slow = useRef(0);
  const frames = useRef(0);
  const elapsed = useRef(0);
  useEffect(() => {
    if (paused) return;
    const timer = setInterval(invalidate, 1000 / 30);
    return () => clearInterval(timer);
  }, [invalidate, paused]);
  useFrame((_, delta) => {
    if (delta > 0.065) slow.current++;
    else slow.current = Math.max(0, slow.current - 1);
    if (slow.current === 30) setDpr(0.8);
    frames.current++;
    elapsed.current += delta;
    if (frames.current === 120) {
      window.dispatchEvent(new CustomEvent('office-performance', { detail: { fps: 120 / elapsed.current } }));
      frames.current = 0;
      elapsed.current = 0;
    }
  });
  return null;
}
function FitCamera({ depth }: { depth: number }) {
  const camera = useThree((s) => s.camera),
    size = useThree((s) => s.size),
    invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    camera.zoom = Math.max(2, Math.min(16, size.width / (75 + depth * 0.7), (size.height - 210) / (depth * 0.75 + 35)));
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, size.width, size.height, depth, invalidate]);
  return null;
}
class Boundary extends Component<{ children: ReactNode; onUnavailable: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onUnavailable();
  }
  render() {
    return this.state.failed ? (
      <div className="office-message">3D is unavailable on this device. Explore the same contributions in People.</div>
    ) : (
      this.props.children
    );
  }
}
export default function OfficeScene3D({
  agents,
  visibleIds,
  layout,
  selected,
  onSelect,
  onProduct,
  reset,
  onUnavailable,
  demo = false,
}: {
  agents: AgentStateDTO[];
  visibleIds: string[];
  layout: OfficeLayout;
  selected: string | null;
  onSelect: (id: string) => void;
  onProduct: (id: string) => void;
  reset: number;
  onUnavailable: () => void;
  demo?: boolean;
}) {
  const [paused, setPaused] = useState(false),
    [reduced, setReduced] = useState(false),
    [lost, setLost] = useState(false);
  const spatial = useMemo(() => officeSpatial(agents, layout), [agents, layout]);
  const visible = useMemo(() => new Set(visibleIds), [visibleIds]);
  const bursts = useRef(new Map<string, number>());
  const feed = useLive((s) => s.feed);
  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => {
      setPaused(document.hidden);
      setReduced(mq.matches);
    };
    update();
    document.addEventListener('visibilitychange', update);
    mq.addEventListener('change', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      mq.removeEventListener('change', update);
    };
  }, []);
  useEffect(
    () =>
      useLive.subscribe((state, previous) => {
        if (state.conn !== 'live' || state.freshIds === previous.freshIds) return;
        for (const event of state.feed) {
          if (
            state.freshIds.has(event.id) &&
            event.actor?.id &&
            ['pr.merged', 'release.published'].includes(event.verb) &&
            (demo || event.live === true || event.provenance === 'VERIFIED')
          )
            bursts.current.set(event.actor.id, performance.now() + 3500);
        }
        for (const [id, until] of bursts.current) if (until < performance.now()) bursts.current.delete(id);
      }),
    [demo],
  );
  const target = selected
    ? (spatial.positions.get(selected) ?? ([0, 0, 0] as Point))
    : ([0, 0, spatial.depth / 2 - 12] as Point);
  const active = agents.filter((a) => visible.has(a.employeeId));
  return (
    <Boundary onUnavailable={onUnavailable}>
      <div className="office-canvas" aria-label="Interactive 3D office. Use People for keyboard navigation.">
        {lost && (
          <div className="office-message" role="alert">
            Graphics interrupted.{' '}
            <button
              onClick={() => {
                setLost(false);
                onUnavailable();
              }}
            >
              Open people
            </button>
          </div>
        )}
        <Canvas
          key={reset}
          orthographic
          camera={{ position: [50, 65, 75], zoom: 13, near: 0.1, far: 500 }}
          dpr={[1, 1.5]}
          frameloop="demand"
          onCreated={({ gl }) => {
            gl.domElement.addEventListener('webglcontextlost', (e) => {
              e.preventDefault();
              setLost(true);
              setPaused(true);
            });
            gl.domElement.addEventListener('webglcontextrestored', () => {
              setLost(false);
              setPaused(document.hidden);
            });
          }}
        >
          <FitCamera depth={spatial.depth} />
          <RenderClock paused={paused} />
          <color attach="background" args={['#e9eeeb']} />
          <ambientLight intensity={1.6} />
          <directionalLight position={[15, 30, 10]} intensity={2} />
          <Box position={[0, -0.25, spatial.depth / 2 - 14]} size={[63, 0.4, spatial.depth + 22]} color="#d7dfd8" />
          <Box position={[-31.5, 1, spatial.depth / 2 - 14]} size={[0.3, 2.4, spatial.depth + 22]} color="#bbc9c0" />
          {spatial.zones.map((zone) => (
            <group key={zone.name}>
              <Box
                position={[zone.center[0], -0.02, zone.center[2]]}
                size={[zone.width, 0.06, zone.depth]}
                color="#edf0e7"
              />
              <Html position={[zone.center[0], 0.1, zone.center[2] - zone.depth / 2]} center>
                <span className="office-zone-label" style={{ color: zone.color }}>
                  {zone.name}
                </span>
              </Html>
            </group>
          ))}
          <Furniture
            agents={agents}
            positions={spatial.positions}
            selected={selected}
            visible={visible}
            select={onSelect}
          />
          {active.map((agent, i) => {
            const desk = spatial.positions.get(agent.employeeId)!;
            const act = agent.expiresAt && Date.parse(agent.expiresAt) > Date.now() ? agent.activity : 'NONE';
            return (
              <Employee
                key={agent.employeeId}
                agent={agent}
                desk={desk}
                destination={activityDestination(act, desk, spatial, i)}
                color={spatial.zones.find((z) => z.name === (agent.team ?? 'Unassigned'))?.color ?? '#4e7f8a'}
                selected={agent.employeeId === selected}
                reduced={reduced}
                select={() => onSelect(agent.employeeId)}
                burst={bursts.current}
              />
            );
          })}
          {[
            { name: 'Review table', p: spatial.review, color: '#9a805e' },
            { name: 'CI monitors', p: spatial.ci, color: '#52766d' },
            { name: 'Issue triage', p: spatial.triage, color: '#7b8192' },
          ].map((s) => (
            <group key={s.name} position={s.p}>
              <Box position={[0, 0.9, 0]} size={[6, 0.18, 2]} color={s.color} />
              <Box position={[-2, 0.45, 0]} size={[0.2, 0.9, 1.5]} color="#6d7b70" />
              <Box position={[2, 0.45, 0]} size={[0.2, 0.9, 1.5]} color="#6d7b70" />
              <Html position={[0, 2.4, 0]} center>
                <span className="office-zone-label">{s.name}</span>
              </Html>
            </group>
          ))}
          {layout.products.map((p, i) => {
            const recent = feed.filter((e) => p.repositories.includes(e.repo ?? ''));
            return (
              <group key={p.id} position={[31, 0, i * 6 - 7]}>
                <Box position={[0, 1.8, 0]} size={[0.2, 3.6, 4.5]} color="#365b5b" />
                <Html position={[0.2, 2.1, 0]} transform sprite distanceFactor={7} center>
                  <button className="office-product-sign" onClick={() => onProduct(p.id)}>
                    <strong>{p.name}</strong>
                    <span>
                      {p.openPrs ?? recent.filter((e) => e.verb === 'pr.opened').length} open PRs · {p.failingCi ?? 0}{' '}
                      failing CI
                    </span>
                    <small>Recent activity ↗</small>
                  </button>
                </Html>
              </group>
            );
          })}
          <OrbitControls
            makeDefault
            target={target}
            minZoom={2}
            maxZoom={50}
            minPolarAngle={0.3}
            maxPolarAngle={1.2}
            enableDamping={!reduced}
          />
        </Canvas>
      </div>
    </Boundary>
  );
}
