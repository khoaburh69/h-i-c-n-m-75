import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { Sky, PointerLockControls, Stars, PerspectiveCamera, Environment, Billboard, Html } from '@react-three/drei';
import { Physics, useSphere, useBox, usePlane } from '@react-three/cannon';
import * as THREE from 'three';

// --- Constants ---
const MOVEMENT_SPEED = 12;
const JUMP_FORCE = 6;
const BULLET_SPEED = 40; // Increased for "straighter" feel
const BOT_SHOOT_INTERVAL = 2000;
const MAX_BOTS_PER_TEAM = 8;
const BULLET_LIFETIME = 1000;

// Sound Manager
const sounds = {
  shoot: 'https://assets.mixkit.co/active_storage/sfx/1699/1699-preview.mp3', // Realistic rifle shot
  explosion: 'https://assets.mixkit.co/active_storage/sfx/1703/1703-preview.mp3', // Heavy explosion
  reload: 'https://assets.mixkit.co/active_storage/sfx/1701/1701-preview.mp3', // Gun cocking
  tank: 'https://assets.mixkit.co/active_storage/sfx/2704/2704-preview.mp3', // Heavy engine rumble
  victory: 'https://assets.mixkit.co/active_storage/sfx/1435/1435-preview.mp3', // Cheering
  hit: 'https://assets.mixkit.co/active_storage/sfx/2591/2591-preview.mp3', // Impact
  beep: 'https://assets.mixkit.co/active_storage/sfx/600/600-preview.mp3',
  ambient: 'https://assets.mixkit.co/active_storage/sfx/1697/1697-preview.mp3', // Distant battlefield ambience
};

const audioInstances: Record<string, HTMLAudioElement> = {};
let audioEnabledGlobal = false;
const activeSounds = new Map<string, number>();
const MAX_CONCURRENT_SOUNDS = 3; // Per sound type to prevent "nhão"

const playSynthesizedSound = (type: string) => {
  // Only use as a very quiet fallback to avoid "rè" (distortion)
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    const now = ctx.currentTime;
    if (type === 'shoot') {
      osc.type = 'sine'; // Smoother than square
      osc.frequency.setValueAtTime(120, now);
      osc.frequency.exponentialRampToValueAtTime(40, now + 0.1);
      gain.gain.setValueAtTime(0.01, now); // Even quieter
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
      osc.start(now);
      osc.stop(now + 0.1);
    } else if (type === 'explosion') {
      osc.type = 'triangle'; // Smoother than sawtooth
      osc.frequency.setValueAtTime(40, now);
      osc.frequency.exponentialRampToValueAtTime(0.01, now + 0.5);
      gain.gain.setValueAtTime(0.03, now); // Quieter
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
      osc.start(now);
      osc.stop(now + 0.5);
    }
  } catch (e) {}
};

const playSound = (name: keyof typeof sounds, volumeMultiplier = 1) => {
  if (!audioEnabledGlobal) return;
  
  // Only allow gunshots and explosions as requested
  if (name !== 'shoot' && name !== 'explosion') return;
  
  // Rate limiting to prevent "ồn" and "nhão"
  const count = activeSounds.get(name) || 0;
  if (count >= MAX_CONCURRENT_SOUNDS && (name === 'shoot')) return;
  
  activeSounds.set(name, count + 1);

  if (name === 'shoot' || name === 'explosion') {
    playSynthesizedSound(name);
  }

  try {
    const sound = audioInstances[name];
    if (!sound) return;
    
    // Lowered base volumes significantly to prevent clipping (rè)
    const baseVolume = 0.2;
    const finalVolume = baseVolume * volumeMultiplier;

    if (name === 'shoot' || name === 'explosion') {
      const clone = sound.cloneNode() as HTMLAudioElement;
      clone.volume = Math.min(0.6, finalVolume); // Lower cap
      clone.onended = () => activeSounds.set(name, (activeSounds.get(name) || 1) - 1);
      clone.play().catch(() => activeSounds.set(name, (activeSounds.get(name) || 1) - 1));
    }
  } catch (e) {
    console.error("Audio error:", e);
  }
};

const playSpatialSound = (name: keyof typeof sounds, sourcePos: [number, number, number], playerPos: [number, number, number], maxDist = 50) => {
  const dist = Math.sqrt(
    Math.pow(sourcePos[0] - playerPos[0], 2) +
    Math.pow(sourcePos[1] - playerPos[1], 2) +
    Math.pow(sourcePos[2] - playerPos[2], 2)
  );
  
  if (dist > maxDist) return;
  
  const volumeMultiplier = Math.max(0, 1 - dist / maxDist);
  playSound(name, volumeMultiplier);
};

let nextId = 1000;
const getUniqueId = () => nextId++;

type Team = 'RED' | 'BLUE';

interface Entity {
  id: number;
  pos: [number, number, number];
  team: Team;
  health: number;
}

// --- Hooks ---
const useControls = () => {
  const actions = useRef({
    moveForward: false,
    moveBackward: false,
    moveLeft: false,
    moveRight: false,
    jump: false,
    shoot: false,
    aim: false,
    reload: false,
    toggleFireMode: false,
    grenade: false,
    enterTank: false,
    sprint: false,
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.code) {
        case 'KeyW': actions.current.moveForward = true; break;
        case 'KeyS': actions.current.moveBackward = true; break;
        case 'KeyA': actions.current.moveLeft = true; break;
        case 'KeyD': actions.current.moveRight = true; break;
        case 'Space': actions.current.jump = true; break;
        case 'KeyR': actions.current.reload = true; break;
        case 'KeyG': actions.current.toggleFireMode = true; break;
        case 'KeyF': actions.current.grenade = true; break;
        case 'KeyE': actions.current.enterTank = true; break;
        case 'ShiftLeft': actions.current.sprint = true; break;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      switch (e.code) {
        case 'KeyW': actions.current.moveForward = false; break;
        case 'KeyS': actions.current.moveBackward = false; break;
        case 'KeyA': actions.current.moveLeft = false; break;
        case 'KeyD': actions.current.moveRight = false; break;
        case 'Space': actions.current.jump = false; break;
        case 'KeyR': actions.current.reload = false; break;
        case 'KeyG': actions.current.toggleFireMode = false; break;
        case 'KeyF': actions.current.grenade = false; break;
        case 'KeyE': actions.current.enterTank = false; break;
        case 'ShiftLeft': actions.current.sprint = false; break;
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button === 0) actions.current.shoot = true;
      if (e.button === 2) actions.current.aim = true;
    };
    const handleMouseUp = (e: MouseEvent) => {
      if (e.button === 0) actions.current.shoot = false;
      if (e.button === 2) actions.current.aim = false;
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    
    const handleMobileAction = (e: any) => {
      const { action, value } = e.detail;
      if (action in actions.current) {
        (actions.current as any)[action] = value;
      }
    };
    window.addEventListener('mobile-action', handleMobileAction);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('mobile-action', (e: any) => {});
    };
  }, []);

  return actions;
};

// --- Components ---

const Ground = () => {
  const [ref] = usePlane(() => ({
    rotation: [-Math.PI / 2, 0, 0],
    position: [0, 0, 0],
  }));

  return (
    <mesh ref={ref as any} receiveShadow>
      <planeGeometry args={[1000, 1000]} />
      <meshBasicMaterial color="#2d5a27" />
    </mesh>
  );
};

const VisualBox = ({ position, args = [1, 1, 1], color = 'gray' }: { position: [number, number, number], args?: [number, number, number], color?: string }) => {
  return (
    <mesh position={position} castShadow receiveShadow>
      <boxGeometry args={args} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
};

const Box = ({ position, args = [1, 1, 1], color = 'gray' }: { position: [number, number, number], args?: [number, number, number], color?: string }) => {
  const [ref] = useBox(() => ({
    type: 'Static',
    position,
    args,
  }));

  return (
    <mesh ref={ref as any} castShadow receiveShadow>
      <boxGeometry args={args} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
};

const Tree = ({ position }: { position: [number, number, number] }) => {
  return (
    <Billboard position={position} follow={true}>
      {/* 2D Tree Trunk */}
      <mesh position={[0, 0.75, 0]}>
        <planeGeometry args={[0.4, 1.5]} />
        <meshBasicMaterial color="#3d2b1f" />
      </mesh>
      {/* 2D Tree Leaves */}
      <mesh position={[0, 3, 0]}>
        <circleGeometry args={[1.5, 3]} /> {/* Simple triangle-like shape */}
        <meshBasicMaterial color="#2d5a27" />
      </mesh>
    </Billboard>
  );
};

const IndependencePalace = ({ victory }: { victory: boolean }) => {
  return (
    <>
      {/* Main Building */}
      <Box position={[0, 5, -40]} args={[40, 10, 15]} color="#f0f0f0" />
      {/* Decorative Roof Edge */}
      <VisualBox position={[0, 10.2, -40]} args={[42, 0.5, 16]} color="#d0d0d0" />
      {/* Top Floor */}
      <VisualBox position={[0, 12, -40]} args={[20, 4, 10]} color="#e0e0e0" />
      {/* Roof Top Structure */}
      <VisualBox position={[0, 14.5, -40]} args={[8, 1, 6]} color="#ccc" />
      
      {/* Balcony Railing */}
      <Box position={[0, 10.5, -32.5]} args={[40, 1, 0.2]} color="#ccc" />
      
      {/* Columns */}
      {[...Array(12)].map((_, i) => (
        <Box key={`col-${i}`} position={[-20 + i * 3.6, 5, -32.5]} args={[0.6, 10, 0.6]} color="#ffffff" />
      ))}
      
      {/* Windows */}
      {[...Array(8)].map((_, i) => (
        <React.Fragment key={`win-${i}`}>
          <VisualBox position={[-16 + i * 4.5, 7, -32.6]} args={[2, 3, 0.1]} color="#111" />
          <VisualBox position={[-16 + i * 4.5, 3, -32.6]} args={[2, 3, 0.1]} color="#111" />
        </React.Fragment>
      ))}

      {/* Steps - Cleared in the center for the tank */}
      <VisualBox position={[-12, 0.5, -30]} args={[12, 1, 6]} color="#999" />
      <VisualBox position={[12, 0.5, -30]} args={[12, 1, 6]} color="#999" />
      <VisualBox position={[-12, 1.5, -31]} args={[12, 1, 6]} color="#888" />
      <VisualBox position={[12, 1.5, -31]} args={[12, 1, 6]} color="#888" />
      
      {/* Side Wings */}
      <VisualBox position={[-25, 4, -40]} args={[10, 8, 12]} color="#f0f0f0" />
      <VisualBox position={[25, 4, -40]} args={[10, 8, 12]} color="#f0f0f0" />

      {/* Flagpole */}
      <VisualBox position={[0, 16, -40]} args={[0.2, 4, 0.2]} color="#444" />
      
      {/* Flag */}
      {!victory ? (
        // Cờ VNCH (Vàng 3 sọc đỏ)
        <group position={[1.5, 17, -40]}>
          <mesh castShadow>
            <boxGeometry args={[3, 1.8, 0.05]} />
            <meshStandardMaterial color="#ffff00" />
          </mesh>
          {/* 3 Red Stripes */}
          <mesh position={[0, 0.3, 0.03]}>
            <boxGeometry args={[3, 0.1, 0.01]} />
            <meshBasicMaterial color="#ff0000" />
          </mesh>
          <mesh position={[0, 0, 0.03]}>
            <boxGeometry args={[3, 0.1, 0.01]} />
            <meshBasicMaterial color="#ff0000" />
          </mesh>
          <mesh position={[0, -0.3, 0.03]}>
            <boxGeometry args={[3, 0.1, 0.01]} />
            <meshBasicMaterial color="#ff0000" />
          </mesh>
        </group>
      ) : (
        // Cờ Giải Phóng (Đỏ/Xanh sao vàng)
        <group position={[1.5, 17, -40]}>
          <mesh position={[0, 0.45, 0]} castShadow>
            <boxGeometry args={[3, 0.9, 0.05]} />
            <meshStandardMaterial color="#da251d" />
          </mesh>
          <mesh position={[0, -0.45, 0]} castShadow>
            <boxGeometry args={[3, 0.9, 0.05]} />
            <meshStandardMaterial color="#005aab" />
          </mesh>
          <mesh position={[0, 0, 0.03]}>
            <circleGeometry args={[0.3, 5]} />
            <meshBasicMaterial color="#ffff00" />
          </mesh>
        </group>
      )}
    </>
  );
};

const FenceSection = ({ position, width, height, broken = false }: { position: [number, number, number], width: number, height: number, broken?: boolean }) => {
  const barSpacing = 0.6; // Increased spacing for performance
  const barCount = Math.floor(width / barSpacing);
  
  return (
    <group position={position}>
      {/* Top Rail */}
      <VisualBox position={[0, height / 2, 0]} args={[width, 0.1, 0.1]} color="#222" />
      {/* Bottom Rail */}
      <VisualBox position={[0, -height / 2 + 0.5, 0]} args={[width, 0.1, 0.1]} color="#222" />
      
      {/* Vertical Bars */}
      {[...Array(barCount)].map((_, i) => {
        const isMissing = broken && Math.random() > 0.7;
        if (isMissing) return null;
        
        const x = -width / 2 + i * barSpacing;
        return (
          <VisualBox 
            key={i} 
            position={[x, 0, 0]} 
            args={[0.05, height, 0.05]} 
            color="#111" 
          />
        );
      })}
    </group>
  );
};

const GateDoor = ({ position, args }: { position: [number, number, number], args: [number, number, number] }) => {
  const [ref, api] = useBox(() => ({
    mass: 500,
    position,
    args,
    type: 'Dynamic',
    linearDamping: 0.5,
    angularDamping: 0.5,
  }));

  useEffect(() => {
    if (api) {
      // Apply initial impulse to make it fall forward when it spawns (rammed)
      api.applyImpulse([0, 0, -2000], [0, 2, 0]);
    }
  }, [api]);

  return (
    <group ref={ref as any}>
      {/* Visual representation as a fence */}
      <FenceSection position={[0, 0, 0]} width={args[0]} height={args[1]} />
      {/* Invisible physics box for collision if needed, but the ref is already on the group */}
      <mesh visible={false}>
        <boxGeometry args={args} />
      </mesh>
    </group>
  );
};

const HelicopterEscape = ({ active }: { active: boolean }) => {
  const group = useRef<THREE.Group>(null);
  
  useFrame((state) => {
    if (!active || !group.current) return;
    const t = state.clock.elapsedTime;
    
    // Helicopter flying away sequence
    const progress = Math.min(1, (t % 20) / 20);
    const x = Math.sin(t) * 2;
    const y = 15 + progress * 50;
    const z = -40 - progress * 200;
    
    group.current.position.set(x, y, z);
    group.current.rotation.z = Math.sin(t * 2) * 0.1;
    
    // Rotate main rotor
    const mainRotor = group.current.children[3];
    if (mainRotor) mainRotor.rotation.y = t * 30;
    
    // Rotate tail rotor
    const tailBoom = group.current.children[2];
    if (tailBoom && tailBoom.children[1]) {
      tailBoom.children[1].rotation.x = t * 30;
    }
  });

  if (!active) return null;

  return (
    <group ref={group}>
      {/* Helicopter Body */}
      <Box position={[0, 0, 0]} args={[3, 2, 6]} color="#4b5320" /> {/* Olive drab */}
      {/* Cockpit */}
      <mesh position={[0, 0.5, 2]}>
        <boxGeometry args={[2.5, 1.5, 2]} />
        <meshStandardMaterial color="#88ccff" opacity={0.6} transparent />
      </mesh>
      {/* Tail Boom */}
      <group position={[0, 0.5, -4]}>
        <Box position={[0, 0, 0]} args={[0.5, 0.5, 4]} color="#4b5320" />
        {/* Tail Rotor */}
        <group position={[0.4, 0.5, -1.8]}>
          <Box position={[0, 0, 0]} args={[0.1, 2, 0.2]} color="#222" />
        </group>
      </group>
      {/* Main Rotor Hub */}
      <group position={[0, 1.2, 0]}>
        <Box position={[0, 0, 0]} args={[12, 0.1, 0.6]} color="#111" />
        <Box position={[0, 0, 0]} args={[0.6, 0.1, 12]} color="#111" />
      </group>
      
      {/* Fleeing soldiers clinging to skids - "đu càng" */}
      <group position={[-1.8, -1.5, 0]}>
        <Box position={[0, 0, 0]} args={[0.4, 1.2, 0.4]} color="#d4af37" /> {/* Yellow uniform */}
        <Box position={[0, 0.6, 0]} args={[0.5, 0.5, 0.5]} color="#f5d5b0" /> {/* Head */}
        <Box position={[0.5, 0.3, 0]} args={[0.8, 0.2, 0.2]} color="#d4af37" /> {/* Arm reaching for skid */}
      </group>
      <group position={[1.8, -1.5, 1]}>
        <Box position={[0, 0, 0]} args={[0.4, 1.2, 0.4]} color="#d4af37" />
        <Box position={[0, 0.6, 0]} args={[0.5, 0.5, 0.5]} color="#f5d5b0" />
        <Box position={[-0.5, 0.3, 0]} args={[0.8, 0.2, 0.2]} color="#d4af37" />
      </group>
      <group position={[0, -1.5, -1]}>
        <Box position={[0, 0, 0]} args={[0.4, 1.2, 0.4]} color="#d4af37" />
        <Box position={[0, 0.6, 0]} args={[0.5, 0.5, 0.5]} color="#f5d5b0" />
      </group>
    </group>
  );
};

const Gate = ({ rammed, victory }: { rammed: boolean, victory: boolean }) => {
  return (
    <>
      {/* Main Pillars */}
      <Box position={[-6.5, 3, -15]} args={[1.5, 6, 1.5]} color="#333" />
      <Box position={[6.5, 3, -15]} args={[1.5, 6, 1.5]} color="#333" />
      {/* Top Arch */}
      <Box position={[0, 6.5, -15]} args={[15, 1.5, 1.5]} color="#333" />
      
      {/* Fence Left */}
      <FenceSection position={[-16, 2.5, -15]} width={18} height={4} broken={true} />
      {/* Fence Right */}
      <FenceSection position={[16, 2.5, -15]} width={18} height={4} broken={false} />
      
      {rammed && (
        <>
          <GateDoor position={[-2.5, 3, -15.1]} args={[5, 6, 0.2]} />
          <GateDoor position={[2.5, 3, -14.9]} args={[5, 6, 0.2]} />
        </>
      )}
      {!rammed && (
        <>
          <group position={[0, 3, -15]}>
            <FenceSection position={[-2.5, 0, 0]} width={5} height={6} />
            <FenceSection position={[2.5, 0, 0]} width={5} height={6} />
          </group>
        </>
      )}
      
      <HelicopterEscape active={victory} />
    </>
  );
};

const Debris = ({ position, color }: { position: [number, number, number], color: string }) => {
  const meshRef = useRef<THREE.Mesh>(null);
  const velocity = useMemo(() => new THREE.Vector3(
    (Math.random() - 0.5) * 10,
    Math.random() * 10,
    (Math.random() - 0.5) * 10
  ), []);
  const gravity = -9.81;
  const startTime = useRef(Date.now());

  useFrame((_, delta) => {
    if (!meshRef.current) return;
    const elapsed = (Date.now() - startTime.current) / 1000;
    if (elapsed > 2) return;

    velocity.y += gravity * delta;
    meshRef.current.position.x += velocity.x * delta;
    meshRef.current.position.y += velocity.y * delta;
    meshRef.current.position.z += velocity.z * delta;
    meshRef.current.rotation.x += delta * 5;
    meshRef.current.rotation.y += delta * 5;
    
    if (meshRef.current.position.y < 0) {
      meshRef.current.position.y = 0;
      velocity.set(0, 0, 0);
    }
  });

  return (
    <mesh ref={meshRef} position={new THREE.Vector3(...position)}>
      <boxGeometry args={[0.2, 0.2, 0.2]} />
      <meshBasicMaterial color={color} />
    </mesh>
  );
};

const Tank = ({ active, isControlling, onHitGate, onUpdatePos, onShoot, team }: { 
  active: boolean, 
  isControlling: boolean, 
  onHitGate: () => void, 
  onUpdatePos: (p: [number, number, number]) => void,
  onShoot: (pos: THREE.Vector3, dir: THREE.Vector3, team: Team, isTankShell?: boolean) => void,
  team: Team
}) => {
  const [ref, api] = useBox(() => ({
    mass: 20000,
    position: [0, 1.5, 40],
    args: [4, 3, 8],
    type: 'Dynamic',
    linearDamping: 0.3,
    angularDamping: 0.3,
    angularFactor: [0, 1, 0], // Prevent flipping by only allowing rotation around Y axis
    name: 'tank-BLUE'
  }));

  const controls = useControls();
  const pos = useRef([0, 0, 0]);
  const velocity = useRef([0, 0, 0]);
  const rotation = useRef([0, 0, 0]);
  const turretRotation = useRef(0);
  const barrelElevation = useRef(0);
  const hitTriggered = useRef(false);
  const lastShootTime = useRef(0);
  const { camera, mouse } = useThree();
  
  useEffect(() => {
    if (isControlling && api) {
      api.wakeUp();
    }
  }, [isControlling, api]);
  
  useEffect(() => {
    if (!api?.position) return;
    return api.position.subscribe(p => {
      pos.current = p;
      onUpdatePos(p as [number, number, number]);
      if (active && p[2] <= -14 && !hitTriggered.current) {
        hitTriggered.current = true;
        onHitGate();
      }
    });
  }, [api, active, onHitGate, onUpdatePos]);

  useEffect(() => {
    if (!api?.velocity) return;
    return api.velocity.subscribe(v => velocity.current = v);
  }, [api]);

  useEffect(() => {
    if (!api?.rotation) return;
    return api.rotation.subscribe(r => rotation.current = r);
  }, [api]);

  useFrame((state) => {
    if (!active || !api) return;

    const { moveForward, moveBackward, moveLeft, moveRight, shoot } = controls.current;

    if (isControlling) {
      api.wakeUp();
      let yRot = rotation.current[1];

      // Turret and Barrel rotation based on mouse
      turretRotation.current = THREE.MathUtils.lerp(turretRotation.current, -mouse.x * Math.PI, 0.1);
      barrelElevation.current = THREE.MathUtils.lerp(barrelElevation.current, mouse.y * 0.5, 0.1);

      // Camera-relative movement
      const camEuler = new THREE.Euler(0, camera.rotation.y, 0);
      const forward = new THREE.Vector3(0, 0, -1).applyEuler(camEuler);
      const side = new THREE.Vector3(1, 0, 0).applyEuler(camEuler);
      
      const moveDir = new THREE.Vector3(0, 0, 0);
      if (moveForward) moveDir.add(forward);
      if (moveBackward) moveDir.sub(forward);
      if (moveLeft) moveDir.sub(side);
      if (moveRight) moveDir.add(side);
      
      if (moveDir.length() > 0.1) {
        moveDir.normalize();
        
        // Calculate target angle
        const targetAngle = Math.atan2(moveDir.x, moveDir.z);
        let currentAngle = rotation.current[1];
        
        // Simple angle wrapping
        while (targetAngle - currentAngle > Math.PI) currentAngle += Math.PI * 2;
        while (targetAngle - currentAngle < -Math.PI) currentAngle -= Math.PI * 2;
        
        // Turn towards target angle
        const angleDiff = targetAngle - currentAngle;
        api.angularVelocity.set(0, angleDiff * 2, 0);
        
        // Move forward if facing somewhat correctly
        if (Math.abs(angleDiff) < Math.PI / 2) {
          const speed = 6000000 * Math.cos(angleDiff);
          api.applyLocalForce([0, 0, -speed], [0, 0, 0]);
        }
      }

      // Camera follow - adjusted to look from turret perspective
      const camOffset = new THREE.Vector3(0, 6, 18).applyAxisAngle(new THREE.Vector3(0, 1, 0), yRot);
      camera.position.lerp(new THREE.Vector3(pos.current[0] + camOffset.x, pos.current[1] + camOffset.y, pos.current[2] + camOffset.z), 0.1);
      camera.lookAt(pos.current[0], pos.current[1] + 2, pos.current[2]);

      // Shooting
      if (shoot) {
        const now = state.clock.elapsedTime;
        if (now - lastShootTime.current > 1.5) { // 1.5s cooldown for tank
          // Direction includes turret rotation and barrel elevation
          const baseDir = new THREE.Vector3(0, 0, -1);
          baseDir.applyAxisAngle(new THREE.Vector3(1, 0, 0), barrelElevation.current);
          baseDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), turretRotation.current);
          const dir = baseDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), yRot);
          
          const spawnPos = new THREE.Vector3(pos.current[0], pos.current[1] + 2, pos.current[2]).add(dir.clone().multiplyScalar(5));
          onShoot(spawnPos, dir, team, true);
          lastShootTime.current = now;
          
          // Tank recoil
          api.applyImpulse([dir.x * -5000, 0, dir.z * -5000], [0, 0, 0]);
        }
      }
    } else {
      // Auto move
      if (pos.current[2] > -15) {
        api.applyLocalForce([0, 0, -1000000], [0, 0, 0]);
      }
    }
  });

  const turretRef = useRef<THREE.Group>(null);
  const barrelRef = useRef<THREE.Group>(null);

  useFrame(() => {
    if (turretRef.current) {
      turretRef.current.rotation.y = turretRotation.current;
    }
    if (barrelRef.current) {
      barrelRef.current.rotation.x = barrelElevation.current;
    }
  });

  if (!active) return null;

  return (
    <group ref={ref as any}>
      {/* Tank Body */}
      <mesh castShadow receiveShadow>
        <boxGeometry args={[4.2, 1.8, 8.2]} />
        <meshStandardMaterial color="#2d5a27" roughness={0.8} metalness={0.2} />
      </mesh>
      {/* Top Deck */}
      <mesh position={[0, 1, 0]} castShadow>
        <boxGeometry args={[3.8, 0.4, 7.8]} />
        <meshStandardMaterial color="#244a20" />
      </mesh>
      {/* Left Track */}
      <mesh position={[-2.1, -0.4, 0]} castShadow>
        <boxGeometry args={[0.9, 1.4, 8.4]} />
        <meshStandardMaterial color="#1a1a1a" roughness={0.9} />
      </mesh>
      {/* Right Track */}
      <mesh position={[2.1, -0.4, 0]} castShadow>
        <boxGeometry args={[0.9, 1.4, 8.4]} />
        <meshStandardMaterial color="#1a1a1a" roughness={0.9} />
      </mesh>
      {/* Wheels */}
      {[...Array(6)].map((_, i) => (
        <React.Fragment key={i}>
          <mesh position={[-2.1, -0.8, (i - 2.5) * 1.4]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.5, 0.5, 1, 16]} />
            <meshStandardMaterial color="#111" />
          </mesh>
          <mesh position={[2.1, -0.8, (i - 2.5) * 1.4]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.5, 0.5, 1, 16]} />
            <meshStandardMaterial color="#111" />
          </mesh>
        </React.Fragment>
      ))}
      
      {/* Turret Group */}
      <group position={[0, 1.2, -0.5]} ref={turretRef}>
        <mesh castShadow>
          <cylinderGeometry args={[1.8, 2.2, 1.2, 8]} />
          <meshStandardMaterial color="#2d5a27" />
        </mesh>
        {/* Hatch */}
        <mesh position={[0.6, 0.6, 0.4]}>
          <cylinderGeometry args={[0.5, 0.5, 0.1, 16]} />
          <meshStandardMaterial color="#1a3a16" />
        </mesh>
        {/* Machine Gun */}
        <mesh position={[-0.8, 0.8, 0.2]} rotation={[0.2, 0, 0]}>
          <boxGeometry args={[0.1, 0.1, 1.5]} />
          <meshStandardMaterial color="#111" />
        </mesh>
        
        {/* Barrel Assembly */}
        <group position={[0, 0.2, -1.8]} ref={barrelRef}>
          <mesh rotation={[Math.PI / 2, 0, 0]} castShadow>
            <cylinderGeometry args={[0.25, 0.35, 6, 16]} />
            <meshStandardMaterial color="#1a3a16" />
          </mesh>
          {/* Muzzle Brake */}
          <mesh position={[0, 0, -3.2]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.4, 0.4, 0.6, 16]} />
            <meshStandardMaterial color="#111" />
          </mesh>
        </group>
      </group>
      
      {/* Fuel Tanks at back */}
      <mesh position={[-1, 0.5, 4.2]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.4, 0.4, 1.5, 16]} />
        <meshStandardMaterial color="#1a3a16" />
      </mesh>
      <mesh position={[1, 0.5, 4.2]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.4, 0.4, 1.5, 16]} />
        <meshStandardMaterial color="#1a3a16" />
      </mesh>

      {/* Flag */}
      <mesh position={[1, 2.5, 1]} castShadow>
        <boxGeometry args={[0.1, 2, 0.1]} />
        <meshStandardMaterial color="#444" />
      </mesh>
      <mesh position={[1, 3.5, 1.5]} castShadow>
        <boxGeometry args={[0.01, 0.8, 1.2]} />
        <meshStandardMaterial color="#da251d" />
      </mesh>
    </group>
  );
};

const Bot = ({ 
  id, 
  position, 
  team, 
  onShoot, 
  bots,
  botPositions,
  playerPos,
  health,
  playerTeam
}: { 
  id: number, 
  position: [number, number, number], 
  team: Team, 
  onShoot: (pos: THREE.Vector3, dir: THREE.Vector3, team: Team) => void,
  bots: Entity[],
  botPositions: React.MutableRefObject<Record<number, [number, number, number]>>,
  playerPos: React.MutableRefObject<[number, number, number]>,
  health: number,
  playerTeam: Team
}) => {
  const [ref, api] = useBox(() => ({
    mass: 1,
    position,
    args: [1, 2, 1],
    linearDamping: 0.9,
    angularDamping: 0.9,
  }));

  const lastShootTime = useRef(0);
  const currentPos = useRef<[number, number, number]>([0, 0, 0]);
  useEffect(() => {
    if (!api?.position) return;
    return api.position.subscribe(p => {
      currentPos.current = p;
      botPositions.current[id] = p;
    });
  }, [api, botPositions, id]);

  const targetRef = useRef<[number, number, number] | null>(null);
  const distRef = useRef<number>(Infinity);

  useFrame((state) => {
    if (!ref.current || !api) return;
    
    // Find nearest enemy - only update every 10 frames for performance
    if (state.clock.elapsedTime * 60 % 10 < 1) {
      let nearestEnemyPos: [number, number, number] | null = null;
      let minDist = Infinity;

      // Check player
      if (team !== playerTeam) {
        const dist = new THREE.Vector3(...playerPos.current).distanceTo(new THREE.Vector3(...currentPos.current));
        if (dist < minDist) {
          minDist = dist;
          nearestEnemyPos = playerPos.current;
        }
      }

      // Check other bots
      bots.forEach(b => {
        if (b.team !== team && b.id !== id) {
          const bPos = botPositions.current[b.id] || b.pos;
          const dist = new THREE.Vector3(...bPos).distanceTo(new THREE.Vector3(...currentPos.current));
          if (dist < minDist) {
            minDist = dist;
            nearestEnemyPos = bPos;
          }
        }
      });
      
      targetRef.current = nearestEnemyPos;
      distRef.current = minDist;
    }

    const nearestEnemyPos = targetRef.current;
    const minDist = distRef.current;

    if (nearestEnemyPos) {
      const targetVec = new THREE.Vector3(...nearestEnemyPos);
      const dir = targetVec.clone().sub(new THREE.Vector3(...currentPos.current)).normalize();
      
      // Move logic
      if (minDist > 12) {
        api.velocity.set(dir.x * 3, -1, dir.z * 3);
      } else if (minDist < 6) {
        api.velocity.set(-dir.x * 2, -1, -dir.z * 2);
      } else {
        api.velocity.set(0, -1, 0);
      }

      // Rotate
      const angle = Math.atan2(dir.x, dir.z);
      api.rotation.set(0, angle, 0);

      // Shoot
      if (Date.now() - lastShootTime.current > BOT_SHOOT_INTERVAL + Math.random() * 500) {
        const shootPos = new THREE.Vector3(...currentPos.current).add(new THREE.Vector3(0, 0.5, 0));
        playSound('shoot');
        onShoot(shootPos, dir, team);
        lastShootTime.current = Date.now();
      }
    }
  });

  return (
    <group ref={ref as any} name={`bot-${team}-${id}`}>
      {/* Body Representation */}
      {team === 'BLUE' ? (
        // Quân Giải Phóng: Red on top, Blue on bottom
        <>
          <mesh position={[0, 0.5, 0]} castShadow>
            <boxGeometry args={[1, 1, 1]} />
            <meshStandardMaterial color="#da251d" />
          </mesh>
          <mesh position={[0, -0.5, 0]} castShadow>
            <boxGeometry args={[1, 1, 1]} />
            <meshStandardMaterial color="#005aab" />
          </mesh>
          {/* Star */}
          <mesh position={[0, 0, 0.51]}>
            <circleGeometry args={[0.2, 5]} />
            <meshBasicMaterial color="#ffff00" />
          </mesh>
          {/* Helmet */}
          <mesh position={[0, 1.1, 0]} castShadow>
            <sphereGeometry args={[0.55, 16, 16, 0, Math.PI * 2, 0, Math.PI / 2]} />
            <meshStandardMaterial color="#1a3a16" />
          </mesh>
          {/* Backpack */}
          <mesh position={[0, 0.2, -0.6]} castShadow>
            <boxGeometry args={[0.7, 1, 0.3]} />
            <meshStandardMaterial color="#3d2b1f" />
          </mesh>
        </>
      ) : (
        // Quân Cộng Hòa: Yellow with 3 red stripes
        <>
          <mesh castShadow>
            <boxGeometry args={[1, 2, 1]} />
            <meshStandardMaterial color="#ffff00" />
          </mesh>
          {/* 3 Red Stripes */}
          <mesh position={[0, 0.2, 0.51]}>
            <boxGeometry args={[0.8, 0.05, 0.01]} />
            <meshBasicMaterial color="#ff0000" />
          </mesh>
          <mesh position={[0, 0, 0.51]}>
            <boxGeometry args={[0.8, 0.05, 0.01]} />
            <meshBasicMaterial color="#ff0000" />
          </mesh>
          <mesh position={[0, -0.2, 0.51]}>
            <boxGeometry args={[0.8, 0.05, 0.01]} />
            <meshBasicMaterial color="#ff0000" />
          </mesh>
          {/* Helmet */}
          <mesh position={[0, 1.1, 0]} castShadow>
            <sphereGeometry args={[0.55, 16, 16, 0, Math.PI * 2, 0, Math.PI / 2]} />
            <meshStandardMaterial color="#2d5a27" />
          </mesh>
          {/* Backpack */}
          <mesh position={[0, 0.2, -0.6]} castShadow>
            <boxGeometry args={[0.7, 1, 0.3]} />
            <meshStandardMaterial color="#222" />
          </mesh>
        </>
      )}

      {/* Visor */}
      <mesh position={[0, 0.7, 0.52]}>
        <boxGeometry args={[0.8, 0.2, 0.05]} />
        <meshStandardMaterial color="black" />
      </mesh>

      {/* Gun */}
      <Gun 
        type={team === 'BLUE' ? 'AK47' : 'M16'} 
        position={[0.6, 0, 0.4]} 
        rotation={[0, 0, 0]} 
        scale={0.5} 
      />

      {/* Health Bar for enemies */}
      {team !== playerTeam && (
        <Billboard position={[0, 1.5, 0]}>
          <mesh position={[0, 0, 0]}>
            <planeGeometry args={[1.2, 0.15]} />
            <meshBasicMaterial color="black" transparent opacity={0.5} />
          </mesh>
          <mesh position={[-(1.2 * (1 - health / 100)) / 2, 0, 0.01]}>
            <planeGeometry args={[1.2 * (health / 100), 0.1]} />
            <meshBasicMaterial color={health > 50 ? "#00ff00" : health > 25 ? "#ffff00" : "#ff0000"} />
          </mesh>
        </Billboard>
      )}
    </group>
  );
};

const Gun = ({ type, position, rotation, scale = 1 }: { type: 'AK47' | 'M16', position: [number, number, number], rotation: [number, number, number], scale?: number }) => {
  return (
    <group position={position} rotation={rotation} scale={scale}>
      {type === 'AK47' ? (
        <group>
          {/* Receiver */}
          <mesh castShadow>
            <boxGeometry args={[0.1, 0.15, 0.5]} />
            <meshStandardMaterial color="#222" />
          </mesh>
          {/* Barrel */}
          <mesh position={[0, 0.04, -0.5]} rotation={[Math.PI / 2, 0, 0]} castShadow>
            <cylinderGeometry args={[0.02, 0.02, 0.6]} />
            <meshStandardMaterial color="#111" />
          </mesh>
          {/* Wood Stock */}
          <mesh position={[0, -0.02, 0.45]} rotation={[0.1, 0, 0]} castShadow>
            <boxGeometry args={[0.09, 0.18, 0.5]} />
            <meshStandardMaterial color="#5d3a1a" />
          </mesh>
          {/* Wood Handguard */}
          <mesh position={[0, 0.02, -0.3]} castShadow>
            <boxGeometry args={[0.11, 0.12, 0.3]} />
            <meshStandardMaterial color="#5d3a1a" />
          </mesh>
          {/* Curved Magazine */}
          <mesh position={[0, -0.2, -0.1]} rotation={[0.4, 0, 0]} castShadow>
            <boxGeometry args={[0.06, 0.3, 0.15]} />
            <meshStandardMaterial color="#111" />
          </mesh>
        </group>
      ) : (
        <group>
          {/* Receiver */}
          <mesh castShadow>
            <boxGeometry args={[0.1, 0.18, 0.6]} />
            <meshStandardMaterial color="#333" />
          </mesh>
          {/* Barrel */}
          <mesh position={[0, 0.04, -0.6]} rotation={[Math.PI / 2, 0, 0]} castShadow>
            <cylinderGeometry args={[0.02, 0.02, 0.7]} />
            <meshStandardMaterial color="#222" />
          </mesh>
          {/* Stock */}
          <mesh position={[0, 0, 0.5]} castShadow>
            <boxGeometry args={[0.09, 0.18, 0.4]} />
            <meshStandardMaterial color="#111" />
          </mesh>
          {/* Handguard */}
          <mesh position={[0, 0.04, -0.35]} rotation={[Math.PI / 2, 0, 0]} castShadow>
            <cylinderGeometry args={[0.06, 0.06, 0.4]} />
            <meshStandardMaterial color="#111" />
          </mesh>
          {/* Straight Magazine */}
          <mesh position={[0, -0.2, -0.1]} castShadow>
            <boxGeometry args={[0.06, 0.25, 0.1]} />
            <meshStandardMaterial color="#222" />
          </mesh>
          {/* Carry Handle */}
          <mesh position={[0, 0.12, 0]} castShadow>
            <boxGeometry args={[0.04, 0.05, 0.3]} />
            <meshStandardMaterial color="#222" />
          </mesh>
        </group>
      )}
    </group>
  );
};

const Weapon = ({ weaponRef }: { weaponRef: React.RefObject<THREE.Group | null> }) => {
  return (
    <group ref={weaponRef as any}>
      <Gun type="AK47" position={[0.3, -0.4, -0.6]} rotation={[0, 0, 0]} scale={0.8} />
    </group>
  );
};

const Player = ({ onShoot, onThrowGrenade, playerPosRef, team, onWeaponUpdate, initialPosition = [0, 2, 10] }: { 
  onShoot: (pos: THREE.Vector3, dir: THREE.Vector3, team: Team, isTankShell?: boolean) => void, 
  onThrowGrenade: (pos: THREE.Vector3, dir: THREE.Vector3, team: Team) => void,
  playerPosRef: React.MutableRefObject<[number, number, number]>, 
  team: Team,
  onWeaponUpdate: (state: { ammo: number, fireMode: 'AUTO' | 'SINGLE', isReloading: boolean, grenades: number }) => void,
  initialPosition?: [number, number, number]
}) => {
  const { camera, scene } = useThree();
  const weaponRef = useRef<THREE.Group>(null);
  const [ref, api] = useSphere(() => ({
    mass: 1,
    type: 'Dynamic',
    position: initialPosition,
    args: [1],
    fixedRotation: true,
    name: 'player',
    linearDamping: 0.9,
    angularDamping: 0.9,
  }));

  const velocity = useRef([0, 0, 0]);
  useEffect(() => {
    if (!api?.velocity) return;
    return api.velocity.subscribe((v) => (velocity.current = v));
  }, [api]);

  const pos = useRef([0, 0, 0]);
  useEffect(() => {
    if (!api?.position) return;
    return api.position.subscribe((p) => {
      pos.current = p;
      playerPosRef.current = p;
    });
  }, [api, playerPosRef]);

  const controls = useControls();
  const lastShootTime = useRef(0);
  const lastGrenadeTime = useRef(0);
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const recoilRef = useRef(new THREE.Vector3(0, 0, 0));
  const recoilOffset = useRef(0);
  const shakeRef = useRef(0);

  // Weapon State
  const [ammo, setAmmo] = useState(30);
  const [grenadeCount, setGrenadeCount] = useState(3);
  const [isReloading, setIsReloading] = useState(false);
  const [fireMode, setFireMode] = useState<'AUTO' | 'SINGLE'>('AUTO');
  const [isAiming, setIsAiming] = useState(false);
  const canShoot = useRef(true);
  const canThrow = useRef(true);

  // Update Parent HUD
  useEffect(() => {
    onWeaponUpdate({ ammo, fireMode, isReloading, grenades: grenadeCount });
  }, [ammo, fireMode, isReloading, grenadeCount, onWeaponUpdate]);

  useEffect(() => {
    const handleImpact = (e: any) => {
      const { pos: impactPos } = e.detail;
      const dist = new THREE.Vector3(...pos.current).distanceTo(impactPos);
      if (dist < 15) {
        shakeRef.current = Math.max(shakeRef.current, (1 - dist / 15) * 0.5);
      }
    };
    window.addEventListener('bullet-impact', handleImpact);
    return () => window.removeEventListener('bullet-impact', handleImpact);
  }, []);

  const direction = useMemo(() => new THREE.Vector3(), []);
  const frontVector = useMemo(() => new THREE.Vector3(), []);
  const sideVector = useMemo(() => new THREE.Vector3(), []);

  const prevControls = useRef(controls.current);

  useFrame((state) => {
    const { moveForward, moveBackward, moveLeft, moveRight, jump, shoot, aim, reload, toggleFireMode, grenade, enterTank, sprint } = controls.current;
    
    // Handle one-shot actions
    if (toggleFireMode && !prevControls.current.toggleFireMode) {
      setFireMode(prev => prev === 'AUTO' ? 'SINGLE' : 'AUTO');
    }
    if (reload && !prevControls.current.reload && ammo < 30 && !isReloading) {
      playSound('reload');
      setIsReloading(true);
      setTimeout(() => {
        setAmmo(30);
        setIsReloading(false);
      }, 2000);
    }
    
    prevControls.current = { ...controls.current };

    const shake = shakeRef.current;
    const shakeOffset = new THREE.Vector3(
      (Math.random() - 0.5) * shake,
      (Math.random() - 0.5) * shake,
      (Math.random() - 0.5) * shake
    );
    
    const targetCamPos = new THREE.Vector3(pos.current[0], pos.current[1] + 0.75, pos.current[2]).add(shakeOffset);
    camera.position.lerp(targetCamPos, 0.5);
    shakeRef.current *= 0.9; // Decay shake
    
    // ADS Logic
    setIsAiming(aim);
    const perspectiveCamera = camera as THREE.PerspectiveCamera;
    if (perspectiveCamera.isPerspectiveCamera) {
      const targetFOV = aim ? 45 : 75;
      perspectiveCamera.fov = THREE.MathUtils.lerp(perspectiveCamera.fov, targetFOV, 0.1);
      perspectiveCamera.updateProjectionMatrix();
    }

    // Weapon follow camera with bobbing and sway
    if (weaponRef.current) {
      const targetWeaponPos = aim 
        ? new THREE.Vector3(0, -0.15, -0.3) // ADS Position
        : new THREE.Vector3(0.3, -0.4, -0.6); // Hipfire Position
      
      // Apply recoil to target position (kick back and up)
      const recoilPos = targetWeaponPos.clone().add(new THREE.Vector3(0, recoilRef.current.x * 0.2, recoilRef.current.x * 0.5));
      
      weaponRef.current.position.lerp(camera.position.clone().add(recoilPos.applyQuaternion(camera.quaternion)), 0.2);
      
      // Recoil rotation (tilt UP)
      const recoilRot = new THREE.Euler(recoilRef.current.x, recoilRef.current.y, recoilRef.current.z);
      const targetQuat = camera.quaternion.clone().multiply(new THREE.Quaternion().setFromEuler(recoilRot));
      weaponRef.current.quaternion.slerp(targetQuat, 0.2);
      
      // Apply camera kick with recovery (giật lên xong quay về)
      if (recoilOffset.current > 0.001) {
        const recovery = recoilOffset.current * 0.1;
        camera.rotation.x -= recovery;
        recoilOffset.current -= recovery;
      }
      
      const kick = recoilRef.current.x * 0.05;
    // Recoil recovery
    if (recoilOffset.current > 0.001) {
      const recovery = recoilOffset.current * 0.1;
      camera.rotation.x -= recovery;
      recoilOffset.current -= recovery;
    } else {
      recoilOffset.current = 0;
    }

    // Weapon sway & bobbing
    const time = state.clock.getElapsedTime();
      const horizontalSpeed = Math.sqrt(velocity.current[0]**2 + velocity.current[2]**2);
      const speedFactor = Math.min(horizontalSpeed / MOVEMENT_SPEED, 1);
      
      if (!aim) {
        const bobFreq = speedFactor > 0.1 ? 12 : 2;
        const bobAmp = 0.004 + (0.016 * speedFactor);
        weaponRef.current.position.y += Math.sin(time * bobFreq) * bobAmp;
        weaponRef.current.position.x += Math.cos(time * bobFreq * 0.5) * bobAmp * 0.5;
        // Removed rotation.z sway (tilt)
        weaponRef.current.rotation.x += velocity.current[2] * 0.005;
      }

      // Recover recoil
      recoilRef.current.lerp(new THREE.Vector3(0, 0, 0), 0.1);
    }

      frontVector.set(0, 0, Number(moveBackward) - Number(moveForward));
      sideVector.set(Number(moveLeft) - Number(moveRight), 0, 0);

      const camEuler = new THREE.Euler(0, camera.rotation.y, 0);
      const currentSpeed = sprint ? MOVEMENT_SPEED * 1.6 : MOVEMENT_SPEED;
      
      direction
        .subVectors(frontVector, sideVector)
        .normalize()
        .multiplyScalar(currentSpeed)
        .applyEuler(camEuler);

      api.velocity.set(direction.x, velocity.current[1], direction.z);

    if (jump && Math.abs(velocity.current[1]) < 0.05) {
      api.velocity.set(velocity.current[0], JUMP_FORCE, velocity.current[2]);
    }

    // Shooting Logic
    const now = Date.now();
    const shootDelay = fireMode === 'AUTO' ? 100 : 300;
    
    if (shoot && now - lastShootTime.current > shootDelay && ammo > 0 && !isReloading && canShoot.current) {
      if (fireMode === 'SINGLE') canShoot.current = false;
      
      playSound('shoot');
      setAmmo(prev => prev - 1);
      const damage = fireMode === 'SINGLE' ? 50 : 25;
      
      // Apply recoil kick
      const recoilAmount = fireMode === 'SINGLE' ? 0.08 : 0.04;
      camera.rotation.x += recoilAmount;
      recoilOffset.current += recoilAmount;

      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const spawnPos = camera.position.clone().add(dir.clone().multiplyScalar(1));
      onShoot(spawnPos, dir, team);
      
      raycaster.set(camera.position, dir);
      const intersects = raycaster.intersectObjects(scene.children, true);
      
      for (const intersect of intersects) {
        let obj = intersect.object;
        while (obj) {
          if (obj.name && obj.name.startsWith('bot-')) {
            const parts = obj.name.split('-');
            const botTeam = parts[1] as Team;
            const botId = parseInt(parts[2]);
            
            if (botTeam !== team) {
              const hitEvent = new CustomEvent('entity-hit', { 
                detail: { type: 'bot', team: botTeam, id: botId, damage } 
              });
              window.dispatchEvent(hitEvent);
            }
            break;
          }
          if (obj.name && obj.name.startsWith('tank-')) {
            const parts = obj.name.split('-');
            const tankTeam = parts[1] as Team;
            if (tankTeam !== team) {
              // Tank doesn't have health yet, but we show impact
              window.dispatchEvent(new CustomEvent('bullet-impact', { detail: { pos: intersect.point, team: tankTeam } }));
            }
            break;
          }
          obj = obj.parent as any;
        }
        if (intersect.distance < 100) break;
      }
      
      lastShootTime.current = now;
    }

    if (!shoot) {
      canShoot.current = true;
    }

    // Grenade Logic
    if (grenade && now - lastGrenadeTime.current > 1000 && grenadeCount > 0 && canThrow.current) {
      canThrow.current = false;
      setGrenadeCount(prev => prev - 1);
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const spawnPos = camera.position.clone().add(dir.clone().multiplyScalar(1));
      onThrowGrenade(spawnPos, dir, team);
      lastGrenadeTime.current = now;
    }

    if (!grenade) {
      canThrow.current = true;
    }
  });

  return (
    <>
      <mesh ref={ref as any} name={`player-${team}`} />
      <Weapon weaponRef={weaponRef} />
    </>
  );
};

const MobileControls = () => {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth < 1024);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  if (!isMobile) return null;

  const handleAction = (action: string, value: boolean) => {
    window.dispatchEvent(new CustomEvent('mobile-action', { detail: { action, value } }));
  };

  return (
    <div className="fixed inset-0 z-50 pointer-events-none select-none">
      {/* Movement Buttons - Modern Design */}
      <div className="absolute bottom-12 left-12 flex flex-col items-center gap-2 pointer-events-auto">
        <button 
          className="w-16 h-16 bg-black/40 backdrop-blur-md border border-white/20 rounded-2xl flex items-center justify-center active:scale-95 active:bg-white/20 transition-all shadow-xl"
          onPointerDown={() => handleAction('moveForward', true)}
          onPointerUp={() => handleAction('moveForward', false)}
          onPointerLeave={() => handleAction('moveForward', false)}
        >
          <div className="w-0 h-0 border-l-[10px] border-l-transparent border-r-[10px] border-r-transparent border-b-[15px] border-b-white/80" />
        </button>
        <div className="flex gap-2">
          <button 
            className="w-16 h-16 bg-black/40 backdrop-blur-md border border-white/20 rounded-2xl flex items-center justify-center active:scale-95 active:bg-white/20 transition-all shadow-xl"
            onPointerDown={() => handleAction('moveLeft', true)}
            onPointerUp={() => handleAction('moveLeft', false)}
            onPointerLeave={() => handleAction('moveLeft', false)}
          >
            <div className="w-0 h-0 border-t-[10px] border-t-transparent border-b-[10px] border-b-transparent border-r-[15px] border-r-white/80" />
          </button>
          <button 
            className="w-16 h-16 bg-black/40 backdrop-blur-md border border-white/20 rounded-2xl flex items-center justify-center active:scale-95 active:bg-white/20 transition-all shadow-xl"
            onPointerDown={() => handleAction('moveBackward', true)}
            onPointerUp={() => handleAction('moveBackward', false)}
            onPointerLeave={() => handleAction('moveBackward', false)}
          >
            <div className="w-0 h-0 border-l-[10px] border-l-transparent border-r-[10px] border-r-transparent border-t-[15px] border-t-white/80" />
          </button>
          <button 
            className="w-16 h-16 bg-black/40 backdrop-blur-md border border-white/20 rounded-2xl flex items-center justify-center active:scale-95 active:bg-white/20 transition-all shadow-xl"
            onPointerDown={() => handleAction('moveRight', true)}
            onPointerUp={() => handleAction('moveRight', false)}
            onPointerLeave={() => handleAction('moveRight', false)}
          >
            <div className="w-0 h-0 border-t-[10px] border-t-transparent border-b-[10px] border-b-transparent border-l-[15px] border-l-white/80" />
          </button>
        </div>
      </div>

      {/* Action Buttons - Modern Design */}
      <div className="absolute bottom-12 right-12 flex flex-col items-end gap-6 pointer-events-auto">
        <div className="flex gap-6 items-end">
          <button 
            className="w-24 h-24 bg-red-600/40 backdrop-blur-md border-4 border-red-500/30 rounded-full flex items-center justify-center active:scale-90 active:bg-red-600/60 transition-all shadow-2xl shadow-red-900/40"
            onPointerDown={() => handleAction('shoot', true)}
            onPointerUp={() => handleAction('shoot', false)}
            onPointerLeave={() => handleAction('shoot', false)}
          >
            <div className="w-10 h-10 rounded-full border-4 border-white/90" />
          </button>
          <div className="flex flex-col gap-4">
            <button 
              className="w-16 h-16 bg-blue-600/40 backdrop-blur-md border border-blue-500/30 rounded-full flex items-center justify-center active:scale-90 active:bg-blue-600/60 transition-all shadow-xl"
              onPointerDown={() => handleAction('aim', true)}
              onPointerUp={() => handleAction('aim', false)}
              onPointerLeave={() => handleAction('aim', false)}
            >
              <div className="w-6 h-6 border-2 border-white/90 rounded-sm" />
            </button>
            <button 
              className="w-16 h-16 bg-yellow-600/40 backdrop-blur-md border border-yellow-500/30 rounded-full flex items-center justify-center active:scale-90 active:bg-yellow-600/60 transition-all shadow-xl"
              onPointerDown={() => handleAction('reload', true)}
              onPointerUp={() => handleAction('reload', false)}
              onPointerLeave={() => handleAction('reload', false)}
            >
              <div className="text-[10px] font-black text-white">R</div>
            </button>
          </div>
        </div>
        <div className="flex gap-4">
          <button 
            className="px-8 py-4 bg-white/10 backdrop-blur-md border border-white/20 rounded-2xl text-[10px] font-black uppercase tracking-[0.3em] text-white active:bg-white/30 transition-all shadow-lg"
            onPointerDown={() => handleAction('jump', true)}
            onPointerUp={() => handleAction('jump', false)}
            onPointerLeave={() => handleAction('jump', false)}
          >
            Nhảy
          </button>
          <button 
            className="px-8 py-4 bg-white/10 backdrop-blur-md border border-white/20 rounded-2xl text-[10px] font-black uppercase tracking-[0.3em] text-white active:bg-white/30 transition-all shadow-lg"
            onPointerDown={() => handleAction('grenade', true)}
            onPointerUp={() => handleAction('grenade', false)}
            onPointerLeave={() => handleAction('grenade', false)}
          >
            Lựu đạn
          </button>
        </div>
      </div>
    </div>
  );
};

const TouchControls = () => {
  const { camera, gl } = useThree();
  const isDragging = useRef(false);
  const lastX = useRef(0);
  const lastY = useRef(0);

  useEffect(() => {
    const handleTouchStart = (e: TouchEvent) => {
      // Only rotate if touching the right half of the screen
      if (e.touches.length === 1 && e.touches[0].clientX > window.innerWidth / 2) {
        isDragging.current = true;
        lastX.current = e.touches[0].clientX;
        lastY.current = e.touches[0].clientY;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (isDragging.current && e.touches.length === 1) {
        const deltaX = e.touches[0].clientX - lastX.current;
        const deltaY = e.touches[0].clientY - lastY.current;
        
        camera.rotation.y -= deltaX * 0.005;
        camera.rotation.x -= deltaY * 0.005;
        camera.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, camera.rotation.x));
        
        lastX.current = e.touches[0].clientX;
        lastY.current = e.touches[0].clientY;
      }
    };

    const handleTouchEnd = () => {
      isDragging.current = false;
    };

    gl.domElement.addEventListener('touchstart', handleTouchStart);
    gl.domElement.addEventListener('touchmove', handleTouchMove);
    gl.domElement.addEventListener('touchend', handleTouchEnd);

    return () => {
      gl.domElement.removeEventListener('touchstart', handleTouchStart);
      gl.domElement.removeEventListener('touchmove', handleTouchMove);
      gl.domElement.removeEventListener('touchend', handleTouchEnd);
    };
  }, [camera, gl]);

  return null;
};

const HtmlOverlay = ({ ammo, grenades, isReloading, fireMode }: { ammo: number, grenades: number, isReloading: boolean, fireMode: 'AUTO' | 'SINGLE' }) => {
  const [reloadProgress, setReloadProgress] = useState(0);

  useEffect(() => {
    let interval: any;
    if (isReloading) {
      setReloadProgress(0);
      const start = Date.now();
      interval = setInterval(() => {
        const elapsed = Date.now() - start;
        const progress = Math.min((elapsed / 2000) * 100, 100);
        setReloadProgress(progress);
        if (progress >= 100) clearInterval(interval);
      }, 16);
    } else {
      setReloadProgress(0);
    }
    return () => clearInterval(interval);
  }, [isReloading]);

  const isLowAmmo = ammo < 10 && !isReloading;

  return (
    <div className="fixed top-8 right-8 z-10 text-white text-right pointer-events-none select-none">
      <div className="flex flex-col gap-4 items-end bg-black/20 backdrop-blur-sm p-4 border-r-2 border-white/10">
        
        {/* Weapon Name & Fire Mode */}
        <div className="flex flex-col items-end gap-1">
          <div className="text-[10px] font-black uppercase tracking-[0.5em] text-white/40">AK-47 TYPE 56</div>
          <div className="flex items-center gap-2 mt-1">
            <div className={`px-2 py-0.5 text-[9px] font-black uppercase tracking-widest transition-all ${fireMode === 'AUTO' ? 'bg-white text-black' : 'text-white/20 border border-white/5'}`}>
              Auto
            </div>
            <div className={`px-2 py-0.5 text-[9px] font-black uppercase tracking-widest transition-all ${fireMode === 'SINGLE' ? 'bg-white text-black' : 'text-white/20 border border-white/5'}`}>
              Single
            </div>
          </div>
        </div>

        {/* Main Ammo Display */}
        <div className="relative">
          <div className="flex items-baseline gap-2">
            <div className={`text-7xl font-black tabular-nums leading-none tracking-tighter ${isLowAmmo ? 'text-red-500 animate-pulse' : 'text-white'}`}>
              {isReloading ? (
                <span className="text-3xl tracking-normal text-yellow-500">RELOADING</span>
              ) : (
                ammo.toString().padStart(2, '0')
              )}
            </div>
            {!isReloading && (
              <div className="text-2xl font-bold text-white/20 tabular-nums">/ 30</div>
            )}
          </div>
          
          {/* Visual Ammo Bar (dots) */}
          {!isReloading && (
            <div className="flex gap-0.5 mt-2 justify-end">
              {[...Array(30)].map((_, i) => (
                <div 
                  key={i} 
                  className={`w-1 h-3 ${i < ammo ? (isLowAmmo ? 'bg-red-500' : 'bg-white') : 'bg-white/5'}`}
                />
              ))}
            </div>
          )}
        </div>

        {/* Grenade Count */}
        <div className="flex items-center gap-3">
          <div className="text-[10px] font-black uppercase tracking-[0.3em] text-white/40">Lựu đạn [F]</div>
          <div className="flex gap-1">
            {[...Array(3)].map((_, i) => (
              <div key={i} className={`w-3 h-3 rounded-full ${i < grenades ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]' : 'bg-white/5'}`} />
            ))}
          </div>
        </div>

        {/* Reload Progress Bar */}
        {isReloading && (
          <div className="w-full h-1.5 bg-white/5 border border-white/10 relative overflow-hidden">
            <div 
              className="h-full bg-yellow-500 transition-all duration-75" 
              style={{ width: `${reloadProgress}%` }}
            />
          </div>
        )}
        
        {/* Controls Hint */}
        <div className="flex flex-col gap-1 text-[9px] font-bold uppercase tracking-[0.2em] text-white/30">
          <div className="flex gap-4">
            <span>[WASD] Di chuyển</span>
            <span>[Chuột Trái] Bắn</span>
            <span>[G] Chế độ</span>
          </div>
          <div className="flex gap-4">
            <span>[R] Nạp đạn</span>
            <span>[F] Lựu đạn</span>
            <span>[E] Vào/Thoát Xe Tăng</span>
          </div>
        </div>
      </div>
    </div>
  );
};

const Bullet = ({ position, direction, team }: { position: THREE.Vector3, direction: THREE.Vector3, team: Team }) => {
  const [ref, api] = useSphere(() => ({
    mass: 0.05,
    position: [position.x, position.y, position.z],
    velocity: [direction.x * BULLET_SPEED, direction.y * BULLET_SPEED, direction.z * BULLET_SPEED],
    args: [0.05],
    onCollide: (e) => {
      const impactPos = new THREE.Vector3(...pos.current);
      window.dispatchEvent(new CustomEvent('bullet-impact', { detail: { pos: impactPos, team } }));
    }
  }));

  const pos = useRef<[number, number, number]>([0, 0, 0]);
  useEffect(() => {
    const unsubscribe = api.position.subscribe(v => pos.current = v);
    return () => unsubscribe();
  }, [api.position]);

  const rotation = useMemo(() => new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize())), [direction]);

  return (
    <group ref={ref as any}>
      <mesh rotation={rotation}>
        <boxGeometry args={[0.04, 0.5, 0.04]} />
        <meshBasicMaterial color={team === 'RED' ? '#ffcc00' : '#00ff00'} />
      </mesh>
    </group>
  );
};

const MuzzleFlash = ({ position, direction }: { position: THREE.Vector3, direction: THREE.Vector3 }) => {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), 50);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <group position={position} rotation={new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction))}>
      <mesh position={[0, 0, 0.2]}>
        <sphereGeometry args={[0.2, 4, 4]} />
        <meshBasicMaterial color="#ffaa00" transparent opacity={0.6} />
      </mesh>
    </group>
  );
};

const Spark = ({ position, color }: { position: THREE.Vector3, color: string }) => {
  const meshRef = useRef<THREE.Mesh>(null);
  const velocity = useMemo(() => new THREE.Vector3(
    (Math.random() - 0.5) * 5,
    Math.random() * 5,
    (Math.random() - 0.5) * 5
  ), []);
  const gravity = -9.81;
  const startTime = useRef(Date.now());

  useFrame((_, delta) => {
    if (!meshRef.current) return;
    const elapsed = (Date.now() - startTime.current) / 1000;
    if (elapsed > 1) return;

    velocity.y += gravity * delta;
    meshRef.current.position.x += velocity.x * delta;
    meshRef.current.position.y += velocity.y * delta;
    meshRef.current.position.z += velocity.z * delta;
    meshRef.current.scale.multiplyScalar(0.95);
  });

  return (
    <mesh ref={meshRef} position={position}>
      <sphereGeometry args={[0.02, 3, 3]} />
      <meshBasicMaterial color={color} />
    </mesh>
  );
};

const Grenade = ({ position, direction, team, onExplode }: { position: THREE.Vector3, direction: THREE.Vector3, team: Team, onExplode: (pos: THREE.Vector3) => void }) => {
  const [ref, api] = useSphere(() => ({
    mass: 1,
    position: [position.x, position.y, position.z],
    velocity: [direction.x * 15, direction.y * 15 + 5, direction.z * 15],
    args: [0.15],
    linearDamping: 0.5,
    restitution: 0.6,
  }));

  const pos = useRef(new THREE.Vector3());
  const onExplodeRef = useRef(onExplode);
  
  useEffect(() => {
    onExplodeRef.current = onExplode;
  }, [onExplode]);

  useEffect(() => api.position.subscribe(p => pos.current.set(p[0], p[1], p[2])), [api.position]);

  useEffect(() => {
    const timer = setTimeout(() => {
      onExplodeRef.current(pos.current.clone());
    }, 3000); // Reduced fuse time for better gameplay
    return () => clearTimeout(timer);
  }, []); // Empty dependency array to ensure it only runs once

  return (
    <mesh ref={ref as any} castShadow>
      <sphereGeometry args={[0.15, 12, 12]} />
      <meshStandardMaterial color="#14532d" />
    </mesh>
  );
};

const Explosion = ({ position }: { position: THREE.Vector3 }) => {
  const [visible, setVisible] = useState(true);
  const particles = useMemo(() => {
    return [...Array(3)].map((_, i) => ({
      id: i,
      offset: new THREE.Vector3(
        (Math.random() - 0.5) * 2,
        Math.random() * 2,
        (Math.random() - 0.5) * 2
      ),
      size: 1 + Math.random() * 2
    }));
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), 600);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <group position={position}>
      <mesh>
        <sphereGeometry args={[2, 4, 4]} />
        <meshBasicMaterial color="#fbbf24" transparent opacity={0.4} />
      </mesh>
      {particles.map(p => (
        <mesh key={p.id} position={p.offset}>
          <sphereGeometry args={[p.size, 3, 3]} />
          <meshBasicMaterial color="#4b5563" transparent opacity={0.2} />
        </mesh>
      ))}
      <pointLight color="#f59e0b" intensity={1} distance={8} />
    </group>
  );
};

const SmokeCloud = ({ position }: { position: THREE.Vector3 }) => {
  const [visible, setVisible] = useState(true);
  const particles = useMemo(() => {
    return [...Array(2)].map((_, i) => ({
      id: i,
      offset: new THREE.Vector3(
        (Math.random() - 0.5) * 4,
        Math.random() * 3,
        (Math.random() - 0.5) * 4
      ),
      size: 2 + Math.random() * 3
    }));
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), 2500);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <group position={position}>
      {particles.map(p => (
        <mesh key={p.id} position={p.offset}>
          <sphereGeometry args={[p.size, 3, 3]} />
          <meshBasicMaterial color="#374151" transparent opacity={0.1} />
        </mesh>
      ))}
    </group>
  );
};

const Medkit = ({ position, onPickup }: { position: [number, number, number], onPickup: () => void }) => {
  const [ref] = useBox(() => ({
    type: 'Static',
    position,
    args: [0.6, 0.4, 0.6],
    onCollide: (e) => {
      if (e.contact.bi.name === 'player' || e.contact.bj.name === 'player') {
        onPickup();
      }
    }
  }));

  const groupRef = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (groupRef.current) {
      groupRef.current.rotation.y += 0.02;
      groupRef.current.position.y = position[1] + Math.sin(state.clock.elapsedTime * 2) * 0.1;
    }
  });

  return (
    <group ref={ref as any}>
      <group ref={groupRef}>
        <mesh castShadow>
          <boxGeometry args={[0.6, 0.4, 0.6]} />
          <meshStandardMaterial color="white" />
        </mesh>
        {/* Red Cross */}
        <mesh position={[0, 0.21, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[0.4, 0.1]} />
          <meshBasicMaterial color="red" />
        </mesh>
        <mesh position={[0, 0.21, 0]} rotation={[-Math.PI / 2, 0, Math.PI / 2]}>
          <planeGeometry args={[0.4, 0.1]} />
          <meshBasicMaterial color="red" />
        </mesh>
      </group>
      <pointLight color="white" intensity={0.5} distance={3} />
    </group>
  );
};

const GameScene = React.memo(({ 
  victory, 
  gateRammed, 
  tankActive, 
  isDrivingTank, 
  handleHitGate, 
  handleShoot, 
  handleThrowGrenade, 
  playerPos, 
  playerTeam, 
  setWeaponState, 
  bullets, 
  grenades, 
  handleExplode, 
  explosions, 
  debris, 
  sparks, 
  muzzleFlashes, 
  smokeClouds, 
  medkits, 
  handlePickupMedkit, 
  bots, 
  botPositions,
  tankPos,
  sceneRef
}: any) => {
  const { scene } = useThree();
  useEffect(() => {
    sceneRef.current = scene;
  }, [scene, sceneRef]);

  return (
    <Physics 
      gravity={[0, -9.81, 0]} 
      tolerance={0.01} 
      iterations={5} 
      allowSleep={true}
      broadphase="SAP"
      defaultContactMaterial={{ friction: 1.0, restitution: 0.1, contactEquationStiffness: 1e5 }}
    >
      <Ground />
      <IndependencePalace victory={victory} />
      <Gate rammed={gateRammed} victory={victory} />
      
      {/* Trees around the palace and battlefield */}
      <Tree position={[-25, 0, -25]} />
      <Tree position={[25, 0, -25]} />
      <Tree position={[-30, 0, -10]} />
      <Tree position={[30, 0, -10]} />
      <Tree position={[-35, 0, 10]} />
      <Tree position={[35, 0, 10]} />
      <Tree position={[-20, 0, 30]} />
      <Tree position={[20, 0, 30]} />
      <Tree position={[-45, 0, -40]} />
      <Tree position={[45, 0, -40]} />
      <Tree position={[-50, 0, 0]} />
      <Tree position={[50, 0, 0]} />
      <Tree position={[-40, 0, 50]} />
      <Tree position={[40, 0, 50]} />
      {tankActive && (
        <Tank 
          active={tankActive} 
          isControlling={isDrivingTank} 
          onHitGate={() => handleHitGate(new THREE.Vector3(0, 2, -15))} 
          onUpdatePos={(p) => { tankPos.current = p; }}
          onShoot={handleShoot}
          team={playerTeam}
        />
      )}
      {!isDrivingTank && (
        <Player 
          onShoot={handleShoot} 
          onThrowGrenade={handleThrowGrenade} 
          playerPosRef={playerPos} 
          team={playerTeam} 
          onWeaponUpdate={setWeaponState} 
          initialPosition={tankActive ? [tankPos.current[0], 2, tankPos.current[2] + 5] : [0, 2, 10]}
        />
      )}
      {bullets.map((b: any) => (
        <Bullet key={b.id} position={b.pos} direction={b.dir} team={b.team} />
      ))}
      {grenades.map((g: any) => (
        <Grenade key={g.id} position={g.pos} direction={g.dir} team={g.team} onExplode={(pos) => handleExplode(g.id, pos, g.team)} />
      ))}
      {explosions.map((e: any) => (
        <Explosion key={e.id} position={e.pos} />
      ))}
      {debris.map((d: any) => (
        <Debris key={d.id} position={d.pos} color={d.color} />
      ))}
      {sparks.map((s: any) => (
        <Spark key={s.id} position={s.pos} color={s.color} />
      ))}
      {muzzleFlashes.map((f: any) => (
        <MuzzleFlash key={f.id} position={f.pos} direction={f.dir} />
      ))}
      {smokeClouds.map((s: any) => (
        <SmokeCloud key={s.id} position={s.pos} />
      ))}
      {medkits.map((m: any) => (
        <Medkit key={m.id} position={m.pos} onPickup={() => handlePickupMedkit(m.id)} />
      ))}
      {!victory && bots.map((b: any) => (
        <Bot 
          key={b.id} 
          id={b.id} 
          position={b.pos} 
          team={b.team} 
          onShoot={handleShoot} 
          bots={bots}
          botPositions={botPositions}
          playerPos={playerPos}
          health={b.health}
          playerTeam={playerTeam}
        />
      ))}
      
      {/* Additional tactical obstacles - Cleared from the center path */}
      <Box position={[10, 1, -5]} args={[2, 2, 2]} color="#444" />
      <Box position={[-10, 1, -5]} args={[2, 2, 2]} color="#444" />
      <Box position={[8, 1, 5]} args={[3, 2, 1]} color="#555" />
      <Box position={[-8, 1, 5]} args={[3, 2, 1]} color="#555" />
      <Box position={[15, 1, 15]} args={[4, 2, 1]} color="#333" />
      <Box position={[-15, 1, 15]} args={[4, 2, 1]} color="#333" />
    </Physics>
  );
});

export default function App() {
  const [bullets, setBullets] = useState<{ id: number, pos: THREE.Vector3, dir: THREE.Vector3, team: Team }[]>([]);
  const [grenades, setGrenades] = useState<{ id: number, pos: THREE.Vector3, dir: THREE.Vector3, team: Team }[]>([]);
  const [explosions, setExplosions] = useState<{ id: number, pos: THREE.Vector3 }[]>([]);
  const [smokeClouds, setSmokeClouds] = useState<{ id: number, pos: THREE.Vector3 }[]>([]);
  const [bots, setBots] = useState<Entity[]>([
    // Enemy (RED) - Some inside, some outside gate (-15)
    { id: 1, pos: [3, 1, -10], team: 'RED', health: 100 },  // Outside gate
    { id: 2, pos: [-3, 1, -12], team: 'RED', health: 100 }, // Outside gate
    { id: 3, pos: [8, 1, -11], team: 'RED', health: 100 },  // Outside gate
    { id: 4, pos: [-8, 1, -10], team: 'RED', health: 100 }, // Outside gate
    { id: 5, pos: [5, 1, -35], team: 'RED', health: 100 },  // Inside palace
    { id: 6, pos: [-5, 1, -35], team: 'RED', health: 100 }, // Inside palace
    
    // Allies (BLUE)
    { id: 7, pos: [10, 1, 10], team: 'BLUE', health: 100 },
    { id: 8, pos: [-10, 1, 15], team: 'BLUE', health: 100 },
    { id: 9, pos: [0, 1, 25], team: 'BLUE', health: 100 },
  ]);
  const [score, setScore] = useState({ RED: 0, BLUE: 0 });
  const [health, setHealth] = useState(100);
  const [tankHealth, setTankHealth] = useState(500);
  const [showDamageFlash, setShowDamageFlash] = useState(false);
  const [muzzleFlashes, setMuzzleFlashes] = useState<{ id: number, pos: THREE.Vector3, dir: THREE.Vector3 }[]>([]);
  const [sparks, setSparks] = useState<{ id: number, pos: THREE.Vector3, color: string }[]>([]);
  const [gameStarted, setGameStarted] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const playerPos = useRef<[number, number, number]>([0, 2, 10]);
  const [playerTeam, setPlayerTeam] = useState<Team>('BLUE');
  const [tankActive, setTankActive] = useState(false);
  const [tankSpawned, setTankSpawned] = useState(false);
  const [isDrivingTank, setIsDrivingTank] = useState(false);
  const [gateRammed, setGateRammed] = useState(false);
  const [victory, setVictory] = useState(false);
  const [debris, setDebris] = useState<{ id: number, pos: [number, number, number], color: string }[]>([]);
  const [medkits, setMedkits] = useState<{ id: number, pos: [number, number, number] }[]>([]);
  const [isHealing, setIsHealing] = useState(false);
  const [isNearTank, setIsNearTank] = useState(false);
  const [isAudioOn, setIsAudioOn] = useState(false);
  
  // Initialize sounds
  useEffect(() => {
    Object.keys(sounds).forEach(name => {
      if (!audioInstances[name]) {
        audioInstances[name] = new Audio(sounds[name as keyof typeof sounds]);
        if (name === 'tank') {
          audioInstances[name].loop = true;
          audioInstances[name].volume = 0.1;
        } else if (name === 'ambient') {
          audioInstances[name].loop = true;
          audioInstances[name].volume = 0.05;
        } else {
          audioInstances[name].volume = 0.25;
        }
      }
    });
  }, []);

  const botPositions = useRef<Record<number, [number, number, number]>>({});
  const tankPos = useRef<[number, number, number]>([0, 1.5, 40]);

  // Weapon State for HUD
  const [weaponState, setWeaponState] = useState({
    ammo: 30,
    fireMode: 'AUTO' as 'AUTO' | 'SINGLE',
    isReloading: false,
    grenades: 3
  });

  const sceneRef = useRef<THREE.Scene | null>(null);
  const raycaster = useMemo(() => new THREE.Raycaster(), []);

  useEffect(() => {
    if (score.BLUE >= 800 && !tankSpawned) {
      setTankActive(true);
      setTankSpawned(true);
      playSound('victory');
    }
  }, [score.BLUE, tankSpawned]);

  useEffect(() => {
    const handleEntityHit = (e: any) => {
      const { type, team, id, damage = 25, currentPos } = e.detail;
      playSound('hit');
      
      if (type === 'bot') {
        setBots(prev => {
          const botToHit = prev.find(b => b.id === id && b.team === team);
          if (!botToHit) return prev;

          const newHealth = botToHit.health - damage;
          if (newHealth <= 0) {
            setScore(s => ({ ...s, [team === 'RED' ? 'BLUE' : 'RED']: s[team === 'RED' ? 'BLUE' : 'RED'] + 100 }));
            const explosionPos = currentPos ? new THREE.Vector3(...currentPos) : new THREE.Vector3(...botToHit.pos);
            setExplosions(prev => [...prev, { id: getUniqueId(), pos: explosionPos }]);
            
            // Spawn medkit with 30% chance
            if (Math.random() < 0.3) {
              setMedkits(prevM => [...prevM, { id: getUniqueId(), pos: [explosionPos.x, 0.2, explosionPos.z] }]);
            }

            // Check if we can respawn (limit troop count)
            const teamCount = prev.filter(b => b.team === team).length;
            if (teamCount <= MAX_BOTS_PER_TEAM) {
              setTimeout(() => {
                setBots(current => {
                  if (current.filter(b => b.team === team).length >= MAX_BOTS_PER_TEAM) return current;
                  
                  // Tactical respawn
                  let spawnZ = 0;
                  if (team === 'RED') {
                    // Enemy spawns near palace or gate
                    spawnZ = -15 - Math.random() * 30;
                  } else {
                    // Allies spawn near player start
                    spawnZ = 10 + Math.random() * 20;
                  }

                  return [...current, { 
                    id: getUniqueId(), 
                    pos: [(Math.random() - 0.5) * 40, 1, spawnZ],
                    team: team,
                    health: 100
                  }];
                });
              }, 4000);
            }
            delete botPositions.current[id];
            return prev.filter(b => b.id !== id);
          }
          
          return prev.map(bot => bot.id === id && bot.team === team ? { ...bot, health: newHealth } : bot);
        });
      } else if (type === 'player') {
        setShowDamageFlash(true);
        setTimeout(() => setShowDamageFlash(false), 150);
        setHealth(h => {
          const newHealth = Math.max(0, h - damage);
          if (newHealth === 0) setGameOver(true);
          return newHealth;
        });
      } else if (type === 'tank') {
        // Tank is now invincible
        return;
      }
    };

    window.addEventListener('entity-hit', handleEntityHit);
    
    const handleImpact = (e: any) => {
      const { pos, team } = e.detail;
      const color = team === 'RED' ? '#ffaa00' : '#00ffaa';
      
      playSpatialSound('hit', [pos.x, pos.y, pos.z], playerPos.current, 30);
      
      const newSparks = [];
      for(let i=0; i<2; i++) {
        newSparks.push({ id: getUniqueId(), pos, color });
      }
      setSparks(prev => [...prev.slice(-10), ...newSparks]);
      
      setTimeout(() => {
        setSparks(prev => prev.filter(s => !newSparks.find(ns => ns.id === s.id)));
      }, 500);
    };

    window.addEventListener('bullet-impact', handleImpact);
    
    return () => {
      window.removeEventListener('entity-hit', handleEntityHit);
      window.removeEventListener('bullet-impact', handleImpact);
    };
  }, []);

  // Bot shooting logic - Optimized frequency
  useEffect(() => {
    const interval = setInterval(() => {
      if (!gameStarted || gameOver) return;
      
      // Only process a subset of bots each tick to spread load
      const botsToProcess = bots.filter(() => Math.random() > 0.5);
      
      botsToProcess.forEach(bot => {
        // Target player or tank
        if (bot.team !== playerTeam) {
          const bPos = botPositions.current[bot.id] || bot.pos;
          const playerDist = new THREE.Vector3(...bPos).distanceTo(new THREE.Vector3(...playerPos.current));
          const tankDist = tankActive ? new THREE.Vector3(...bPos).distanceTo(new THREE.Vector3(...tankPos.current)) : Infinity;
          
          if (tankActive && tankDist < playerDist && tankDist < 30) {
            if (Math.random() > 0.9) {
              window.dispatchEvent(new CustomEvent('entity-hit', { detail: { type: 'tank', damage: 10 } }));
            }
          } else if (playerDist < 25 && Math.random() > 0.8) {
            window.dispatchEvent(new CustomEvent('entity-hit', { detail: { type: 'player' } }));
          }
        }
        
        // Target other bots - Limit nested loop frequency
        if (Math.random() > 0.7) {
          bots.forEach(otherBot => {
            if (bot.team !== otherBot.team) {
              const bPos = botPositions.current[bot.id] || bot.pos;
              const oPos = botPositions.current[otherBot.id] || otherBot.pos;
              const dist = new THREE.Vector3(...bPos).distanceTo(new THREE.Vector3(...oPos));
              if (dist < 20 && Math.random() > 0.8) {
                window.dispatchEvent(new CustomEvent('entity-hit', { 
                  detail: { type: 'bot', team: otherBot.team, id: otherBot.id } 
                }));
              }
            }
          });
        }
      });
    }, 1000); // Increased interval
    
    return () => clearInterval(interval);
  }, [gameStarted, gameOver, bots, playerTeam, tankActive]);

  // Ambient explosions for atmosphere
  useEffect(() => {
    const interval = setInterval(() => {
      if (!gameStarted || gameOver) return;
      
      if (Math.random() > 0.7) {
        const x = (Math.random() - 0.5) * 100;
        const z = (Math.random() - 0.5) * 100 - 20; // Focus more on the palace area
        const pos = new THREE.Vector3(x, 0, z);
        
        const id = getUniqueId();
        setExplosions(prev => [...prev, { id, pos }]);
        setSmokeClouds(prev => [...prev, { id, pos }]);
        
        // Trigger screen shake for ambient explosion
        window.dispatchEvent(new CustomEvent('bullet-impact', { detail: { pos, team: 'RED' } }));

        setTimeout(() => {
          setExplosions(prev => prev.filter(e => e.id !== id));
        }, 1000);
      }
    }, 2000);
    
    return () => clearInterval(interval);
  }, [gameStarted, gameOver]);

  useEffect(() => {
    const ambientSound = audioInstances['ambient'];
    if (ambientSound) {
      ambientSound.loop = true;
      if (gameStarted && !gameOver && isAudioOn) {
        ambientSound.play().catch(() => {});
      } else {
        ambientSound.pause();
      }
    }
  }, [gameStarted, gameOver, isAudioOn]);

  useEffect(() => {
    const tankSound = audioInstances['tank'];
    if (tankSound) {
      tankSound.loop = true;
      if (isDrivingTank && !gameOver && isAudioOn) {
        tankSound.play().catch(() => {});
      } else {
        tankSound.pause();
      }
    }
    return () => {
      if (tankSound) tankSound.pause();
    };
  }, [isDrivingTank, gameOver, isAudioOn]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (tankActive && !gameOver && !victory) {
        const dist = new THREE.Vector3(...playerPos.current).distanceTo(new THREE.Vector3(...tankPos.current));
        setIsNearTank(!isDrivingTank && dist < 8);
      } else {
        setIsNearTank(false);
      }
    }, 200);
    return () => clearInterval(interval);
  }, [tankActive, isDrivingTank, gameOver, victory, gateRammed]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'KeyE' && tankActive && !gameOver && !victory) {
        if (isDrivingTank) {
          setIsDrivingTank(false);
        } else {
          const dist = new THREE.Vector3(...playerPos.current).distanceTo(new THREE.Vector3(...tankPos.current));
          if (dist < 12) {
            setIsDrivingTank(true);
            playSound('reload'); // Use reload sound as a placeholder for entering tank
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [tankActive, isDrivingTank, gameOver, victory]);

  const handleHitGate = (pos: THREE.Vector3) => {
    if (gateRammed) return;
    playSpatialSound('explosion', [pos.x, pos.y, pos.z], playerPos.current);
    setGateRammed(true);
    
    setTimeout(() => {
      setVictory(true);
      playSound('victory');
    }, 5000);
    
    // Spawn debris
    const newDebris = [];
    for (let i = 0; i < 10; i++) {
      newDebris.push({
        id: getUniqueId(),
        pos: [pos.x + (Math.random() - 0.5) * 10, pos.y + Math.random() * 5, pos.z] as [number, number, number],
        color: i % 2 === 0 ? '#444' : '#111'
      });
    }
    setDebris(prev => [...prev, ...newDebris]);
    
    // Big explosion at gate
    setExplosions(prev => [...prev, { id: getUniqueId(), pos }]);
    setSmokeClouds(prev => [...prev, { id: getUniqueId(), pos }]);

    // Damage nearby enemies
    bots.forEach(bot => {
      const bPos = botPositions.current[bot.id] || bot.pos;
      const dist = new THREE.Vector3(...bPos).distanceTo(pos);
      if (dist < 12) { // Large radius for gate explosion
        const damage = Math.max(50, 150 * (1 - dist / 12));
        window.dispatchEvent(new CustomEvent('entity-hit', { 
          detail: { type: 'bot', team: bot.team, id: bot.id, damage, currentPos: bPos } 
        }));
      }
    });
  };

  const handleShoot = (pos: THREE.Vector3, dir: THREE.Vector3, team: Team, isTankShell = false) => {
    const id = getUniqueId();
    setBullets(prev => [...prev, { id, pos, dir, team }]);
    
    playSpatialSound('shoot', [pos.x, pos.y, pos.z], playerPos.current);
    
    // Add muzzle flash
    setMuzzleFlashes(prev => [...prev, { id, pos, dir }]);
    setTimeout(() => {
      setMuzzleFlashes(prev => prev.filter(f => f.id !== id));
    }, 50);

    if (isTankShell && sceneRef.current) {
      playSpatialSound('explosion', [pos.x, pos.y, pos.z], playerPos.current);
      // Tank shell logic: raycast for impact
      raycaster.set(pos, dir);
      const intersects = raycaster.intersectObjects(sceneRef.current.children, true);
      if (intersects.length > 0) {
        const impactPos = intersects[0].point;
        setExplosions(prev => [...prev, { id: getUniqueId(), pos: impactPos }]);
        
        // Area damage
        bots.forEach(bot => {
          const bPos = botPositions.current[bot.id] || bot.pos;
          const dist = new THREE.Vector3(...bPos).distanceTo(impactPos);
          if (dist < 10) {
            window.dispatchEvent(new CustomEvent('entity-hit', { 
              detail: { type: 'bot', team: bot.team, id: bot.id, damage: 100 } 
            }));
          }
        });
      }
    }

    setTimeout(() => {
      setBullets(prev => prev.filter(b => b.id !== id));
    }, BULLET_LIFETIME);
  };

  const handleThrowGrenade = (pos: THREE.Vector3, dir: THREE.Vector3, team: Team) => {
    setGrenades(prev => [...prev, { id: getUniqueId(), pos, dir, team }]);
  };

  const handleExplode = useCallback((id: number, pos: THREE.Vector3, team: Team) => {
    playSpatialSound('explosion', [pos.x, pos.y, pos.z], playerPos.current);
    setGrenades(prev => prev.filter(g => g.id !== id));
    setExplosions(prev => [...prev, { id: getUniqueId(), pos }]);
    setSmokeClouds(prev => [...prev, { id: getUniqueId(), pos }]);
    setTimeout(() => setExplosions(prev => prev.slice(1)), 1000);

    // Damage logic
    bots.forEach(bot => {
      const bPos = botPositions.current[bot.id] || bot.pos;
      const dist = new THREE.Vector3(...bPos).distanceTo(pos);
      if (dist < 8) { // Increased radius
        const damage = Math.max(20, 100 * (1 - dist / 8));
        window.dispatchEvent(new CustomEvent('entity-hit', { 
          detail: { type: 'bot', team: bot.team, id: bot.id, damage, currentPos: bPos } 
        }));
      }
    });

    const playerDist = new THREE.Vector3(...playerPos.current).distanceTo(pos);
    if (playerDist < 8) { // Increased radius
      const damage = Math.max(10, 80 * (1 - playerDist / 8));
      window.dispatchEvent(new CustomEvent('entity-hit', { detail: { type: 'player', damage } }));
    }
  }, [bots]);

  const handlePickupMedkit = (id: number) => {
    setMedkits(prev => prev.filter(m => m.id !== id));
    setHealth(h => Math.min(100, h + 30));
    setIsHealing(true);
    setTimeout(() => setIsHealing(false), 500);
  };

  const restartGame = () => {
    setScore({ RED: 0, BLUE: 0 });
    setHealth(100);
    setGameOver(false);
    setGameStarted(false);
    setTankActive(false);
    setIsDrivingTank(false);
    setGateRammed(false);
    setVictory(false);
    setBullets([]);
    setGrenades([]);
    setExplosions([]);
    setDebris([]);
    setMuzzleFlashes([]);
    setSparks([]);
    setSmokeClouds([]);
    setMedkits([]);
    playerPos.current = [0, 2, 10];
    botPositions.current = {};
    setBots([
      // Enemy (RED) - Some inside, some outside gate (-15)
      { id: 1, pos: [3, 1, -10], team: 'RED', health: 100 },  // Outside gate
      { id: 2, pos: [-3, 1, -12], team: 'RED', health: 100 }, // Outside gate
      { id: 3, pos: [8, 1, -11], team: 'RED', health: 100 },  // Outside gate
      { id: 4, pos: [-8, 1, -10], team: 'RED', health: 100 }, // Outside gate
      { id: 5, pos: [5, 1, -35], team: 'RED', health: 100 },  // Inside palace
      { id: 6, pos: [-5, 1, -35], team: 'RED', health: 100 }, // Inside palace
      
      // Allies (BLUE)
      { id: 7, pos: [10, 1, 10], team: 'BLUE', health: 100 },
      { id: 8, pos: [-10, 1, 15], team: 'BLUE', health: 100 },
      { id: 9, pos: [0, 1, 25], team: 'BLUE', health: 100 },
    ]);
  };

  const [isLoading, setIsLoading] = useState(false);

  const startGame = () => {
    // Resume audio context or play silent sound to unlock audio if enabled
    if (isAudioOn) {
      const silent = new Audio();
      silent.play().catch(() => {});
    }
    
    setIsLoading(true);
    setBullets([]);
    setGrenades([]);
    setExplosions([]);
    setDebris([]);
    setMuzzleFlashes([]);
    setSparks([]);
    setSmokeClouds([]);
    setMedkits([]);
    playerPos.current = [0, 2, 10];
    botPositions.current = {};
    setPlayerTeam('BLUE');
    
    setTimeout(() => {
      setGameStarted(true);
      setIsLoading(false);
    }, 1000);
  };

  return (
    <div className="w-full h-screen bg-black overflow-hidden font-sans">
      {isLoading && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black text-white">
          <div className="w-16 h-16 border-4 border-green-500 border-t-transparent rounded-full animate-spin mb-4" />
          <div className="text-xl font-black uppercase tracking-widest animate-pulse">Đang chuẩn bị chiến trường...</div>
        </div>
      )}
      {!gameStarted && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/90 text-white text-center px-4">
          <button 
            onClick={() => {
              const newState = !isAudioOn;
              setIsAudioOn(newState);
              audioEnabledGlobal = newState;
              
              if (newState) {
                // Aggressive unlock
                Object.values(audioInstances).forEach(a => {
                  a.muted = true;
                  a.play().then(() => {
                    a.pause();
                    a.muted = false;
                  }).catch(e => console.error("Unlock error:", e));
                });
                
                // Play a test beep
                setTimeout(() => {
                  playSound('beep');
                }, 100);
              } else {
                Object.values(audioInstances).forEach(a => {
                  a.pause();
                });
              }
            }}
            className={`absolute top-4 right-4 px-4 py-2 border rounded text-xs uppercase tracking-widest transition-all ${isAudioOn ? 'bg-green-500/20 border-green-500 text-green-400' : 'bg-white/10 border-white/20 text-white'}`}
          >
            {isAudioOn ? '🔊 Âm thanh: Bật' : '🔈 Âm thanh: Tắt'}
          </button>
          <div className="relative mb-8">
            <h1 className="text-6xl md:text-8xl font-black tracking-tighter italic uppercase text-white animate-pulse">Hồi ức năm 75</h1>
            <div className="absolute -bottom-2 right-0 text-xl md:text-2xl font-bold bg-green-500 text-black px-2 py-1 transform rotate-3">QUÂN GIẢI PHÓNG</div>
          </div>
          <div className="max-w-xl w-full">
            <div className="group relative p-8 border-2 border-green-600/30 bg-green-900/10 rounded-lg transition-all hover:border-green-500 hover:bg-green-900/20 cursor-pointer text-center" onClick={startGame}>
              <div className="text-green-500 font-bold uppercase text-2xl tracking-widest mb-4">Tiến về Sài Gòn</div>
              <p className="text-base leading-relaxed opacity-70 mb-4">Chiến đấu tiêu diệt địch để tích lũy 800 điểm và triệu hồi xe tăng T-54B tiến về Dinh Độc Lập.</p>
              <div className="text-[10px] uppercase tracking-[0.3em] text-green-500/60 mb-8 flex flex-col gap-1">
                <div>[WASD] Di chuyển | [Chuột Trái] Bắn súng</div>
                <div>[800 Điểm] Triệu hồi xe tăng | [E] Lên/Xuống xe</div>
              </div>
              <button className="w-full py-6 bg-green-700 text-white font-black uppercase tracking-tighter text-2xl group-hover:bg-green-600 transition-colors shadow-[0_0_20px_rgba(22,163,74,0.4)]">Vào trận</button>
            </div>
          </div>
        </div>
      )}

      {gameOver && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/95 text-white">
          <h1 className={`text-9xl font-black mb-4 tracking-tighter uppercase italic ${playerTeam === 'RED' ? 'text-yellow-600' : 'text-green-600'}`}>Thất bại</h1>
          <div className="text-2xl mb-12 opacity-70 uppercase tracking-widest">
            Hiệu suất {playerTeam === 'RED' ? 'Quân Cộng Hòa' : 'Quân Giải Phóng'}: {score[playerTeam]}
          </div>
          <button 
            onClick={restartGame}
            className="px-16 py-8 bg-white text-black font-black rounded-none hover:bg-gray-200 transition-all uppercase tracking-tighter text-3xl"
          >
            Tái triển khai
          </button>
        </div>
      )}

      {victory && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-green-900/90 text-white text-center p-8">
          <h1 className="text-8xl font-black mb-4 tracking-tighter uppercase italic text-yellow-400 animate-bounce">CHIẾN THẮNG!</h1>
          <div className="text-3xl mb-8 font-bold uppercase tracking-widest text-white/90">
            Dinh Độc Lập đã được giải phóng
          </div>
          <div className="text-xl mb-12 max-w-2xl opacity-80 leading-relaxed">
            Bạn đã xuất sắc điều khiển xe tăng húc đổ cổng Dinh, đánh dấu thời khắc lịch sử huy hoàng của dân tộc.
          </div>
          <button 
            onClick={restartGame}
            className="px-16 py-8 bg-yellow-400 text-black font-black rounded-none hover:bg-yellow-300 transition-all uppercase tracking-tighter text-3xl shadow-[0_0_30px_rgba(250,204,21,0.5)]"
          >
            Chơi lại
          </button>
        </div>
      )}

      {isHealing && (
        <>
          <div className="absolute inset-0 z-50 pointer-events-none bg-green-500/20 animate-pulse" />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 text-green-400 font-black text-6xl italic uppercase tracking-tighter animate-bounce pointer-events-none">
            +30 HP
          </div>
        </>
      )}

      {gameStarted && !gameOver && !victory && (
        <>
          {isNearTank && (
            <div className="absolute bottom-1/3 left-1/2 -translate-x-1/2 text-center pointer-events-none z-20">
              <div className="text-white font-black text-3xl uppercase tracking-tighter animate-bounce drop-shadow-[0_5px_5px_rgba(0,0,0,1)]">
                Nhấn <span className="text-yellow-400">[E]</span> để lên xe tăng
              </div>
            </div>
          )}

          {/* Damage Flash Overlay */}
          {showDamageFlash && (
            <div className="fixed inset-0 bg-red-600/40 pointer-events-none z-[100] animate-pulse" />
          )}

          {isDrivingTank && (
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 pointer-events-none">
              <div className="relative w-32 h-32 border-2 border-green-500/30 rounded-full flex items-center justify-center">
                <div className="absolute top-0 left-1/2 -translate-x-1/2 w-0.5 h-6 bg-green-500/50" />
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-0.5 h-6 bg-green-500/50" />
                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-6 h-0.5 bg-green-500/50" />
                <div className="absolute right-0 top-1/2 -translate-y-1/2 w-6 h-0.5 bg-green-500/50" />
                <div className="w-1 h-1 bg-green-500 rounded-full" />
              </div>
              <div className="mt-4 text-green-500 font-black text-xs uppercase tracking-[0.4em] text-center bg-black/40 px-2 py-1">
                Chế độ thiết giáp
              </div>
            </div>
          )}

          <div className="absolute top-8 left-8 z-10 text-white flex flex-col gap-6">
            <div className="flex items-center gap-6">
              <div className="w-3 h-12 bg-green-600 shadow-[0_0_15px_rgba(22,163,74,0.5)]" />
              <div>
                <div className="text-[10px] uppercase tracking-[0.4em] text-green-400 font-bold mb-1">Quân Giải Phóng</div>
                <div className="text-5xl font-black tabular-nums leading-none">{score.BLUE.toString().padStart(4, '0')}</div>
              </div>
            </div>
            <div className="flex items-center gap-6">
              <div className="w-3 h-12 bg-yellow-600 shadow-[0_0_15px_rgba(202,138,4,0.5)]" />
              <div>
                <div className="text-[10px] uppercase tracking-[0.4em] text-yellow-400 font-bold mb-1">Quân Cộng Hòa</div>
                <div className="text-5xl font-black tabular-nums leading-none">{score.RED.toString().padStart(4, '0')}</div>
              </div>
            </div>
          </div>

          <div className="absolute bottom-8 left-8 z-10 text-white">
            <div className="text-[10px] uppercase tracking-[0.4em] text-gray-400 font-bold mb-3">Giáp Chiến Thuật</div>
            <div className="w-80 h-6 bg-white/5 border border-white/10 p-1 relative">
              <div 
                className="h-full bg-gradient-to-r transition-all duration-300" 
                style={{ 
                  width: `${health}%`,
                  backgroundImage: playerTeam === 'BLUE' 
                    ? 'linear-gradient(to right, #166534, #22c55e)' 
                    : 'linear-gradient(to right, #854d0e, #eab308)'
                }} 
              />
              <div className="absolute inset-0 flex items-center justify-center text-[10px] font-black uppercase tracking-[0.2em]">
                {health}%
              </div>
            </div>
            
            {tankActive && (
              <div className="mt-4">
                <div className="text-[10px] uppercase tracking-[0.4em] text-gray-400 font-bold mb-3">Giáp Xe Tăng</div>
                <div className="w-80 h-4 bg-white/5 border border-white/10 p-1 relative">
                  <div 
                    className="h-full bg-green-500 transition-all duration-300" 
                    style={{ width: `${(tankHealth / 500) * 100}%` }} 
                  />
                  <div className="absolute inset-0 flex items-center justify-center text-[8px] font-black uppercase tracking-[0.2em]">
                    {Math.ceil((tankHealth / 500) * 100)}%
                  </div>
                </div>
              </div>
            )}
          </div>

          {!isDrivingTank && (
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 pointer-events-none">
              <div className="relative w-12 h-12">
                <div className={`absolute top-0 left-1/2 -translate-x-1/2 w-0.5 h-3 ${playerTeam === 'BLUE' ? 'bg-green-400/50' : 'bg-yellow-400/50'}`} />
                <div className={`absolute bottom-0 left-1/2 -translate-x-1/2 w-0.5 h-3 ${playerTeam === 'BLUE' ? 'bg-green-400/50' : 'bg-yellow-400/50'}`} />
                <div className={`absolute left-0 top-1/2 -translate-y-1/2 w-3 h-0.5 ${playerTeam === 'BLUE' ? 'bg-green-400/50' : 'bg-yellow-400/50'}`} />
                <div className={`absolute right-0 top-1/2 -translate-y-1/2 w-3 h-0.5 ${playerTeam === 'BLUE' ? 'bg-green-400/50' : 'bg-yellow-400/50'}`} />
                <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1.5 h-1.5 ${playerTeam === 'BLUE' ? 'bg-green-400' : 'bg-yellow-400'} rounded-full shadow-[0_0_10px_rgba(34,197,94,0.8)]`} />
              </div>
            </div>
          )}

          {tankActive && !gateRammed && isDrivingTank && (
            <div className="absolute bottom-1/4 left-1/2 -translate-x-1/2 z-10 text-center">
              <div className="text-2xl font-black text-white bg-black/50 px-6 py-3 rounded-full uppercase tracking-widest border border-white/20">
                SỬ DỤNG <span className="text-yellow-400">[WASD]</span> ĐỂ LÁI XE TĂNG HÚC CỔNG!
              </div>
            </div>
          )}

          {!isDrivingTank && (
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-0 pointer-events-none text-center opacity-20">
              <div className="text-xl font-black text-white uppercase tracking-[1em]">Click để bắt đầu điều khiển</div>
            </div>
          )}

          {!isDrivingTank && <HtmlOverlay ammo={weaponState.ammo} fireMode={weaponState.fireMode} isReloading={weaponState.isReloading} grenades={weaponState.grenades} />}
          
          <MobileControls />

          <Canvas 
            shadows={{ type: THREE.BasicShadowMap }} 
            camera={{ fov: 75 }}
            gl={{ 
              antialias: false, 
              powerPreference: 'high-performance',
              stencil: false,
              depth: true,
              alpha: false
            }}
            dpr={1} // Lock to 1 for performance
            style={{ touchAction: 'none' }}
          >
            <color attach="background" args={["#87ceeb"]} />
            <ambientLight intensity={0.5} />
            <directionalLight position={[10, 20, 10]} intensity={1} castShadow />
            <React.Suspense fallback={null}>
              <GameScene 
                victory={victory}
                gateRammed={gateRammed}
                tankActive={tankActive}
                isDrivingTank={isDrivingTank}
                handleHitGate={handleHitGate}
                handleShoot={handleShoot}
                handleThrowGrenade={handleThrowGrenade}
                playerPos={playerPos}
                playerTeam={playerTeam}
                setWeaponState={setWeaponState}
                bullets={bullets}
                grenades={grenades}
                handleExplode={handleExplode}
                explosions={explosions}
                debris={debris}
                sparks={sparks}
                muzzleFlashes={muzzleFlashes}
                smokeClouds={smokeClouds}
                medkits={medkits}
                handlePickupMedkit={handlePickupMedkit}
                bots={bots}
                botPositions={botPositions}
                tankPos={tankPos}
                sceneRef={sceneRef}
              />
            </React.Suspense>
            {!isDrivingTank && (window.innerWidth >= 1024 ? <PointerLockControls /> : <TouchControls />)}
          </Canvas>
        </>
      )}
    </div>
  );
}
