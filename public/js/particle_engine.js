/**
 * MathSolver - ParticleEngine Module
 * Copyright (c) 2026 ICeCreamChat
 * Licensed under the MIT License.
 *
 * Three.js math symbol particle background.
 */
import * as THREE from 'three';

const ParticleEngine = {
    /**
     * Initializes the 3D particle scene.
     */
    init() {
        const container = document.getElementById('math-canvas-container');
        if (!container) return;

        const { MATH_SYMBOLS_3D, PARTICLE_COUNT_MOBILE, PARTICLE_COUNT_DESKTOP, MOBILE_BREAKPOINT,
            PARTICLE_SPREAD_X, PARTICLE_SPREAD_Y, PARTICLE_SPREAD_Z, PARTICLE_RESET_Y } = window.CONSTANTS;

        const width = window.innerWidth;
        const height = window.innerHeight;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
        camera.position.z = 50;

        const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        container.appendChild(renderer.domElement);

        // Create sprite materials from symbols
        const materials = [];
        MATH_SYMBOLS_3D.forEach(sym => {
            const canvas = document.createElement('canvas');
            canvas.width = 128;
            canvas.height = 128;
            const ctx = canvas.getContext('2d');
            ctx.font = 'bold 60px "JetBrains Mono", monospace';
            ctx.fillStyle = 'white';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(sym, 64, 64);
            const tex = new THREE.CanvasTexture(canvas);
            materials.push(new THREE.SpriteMaterial({
                map: tex, transparent: true, opacity: 0.5, color: 0xffffff
            }));
        });

        const particles = new THREE.Group();
        const particleCount = width < MOBILE_BREAKPOINT ? PARTICLE_COUNT_MOBILE : PARTICLE_COUNT_DESKTOP;

        for (let i = 0; i < particleCount; i++) {
            const mat = materials[Math.floor(Math.random() * materials.length)].clone();
            const sprite = new THREE.Sprite(mat);

            sprite.position.x = (Math.random() - 0.5) * PARTICLE_SPREAD_X;
            sprite.position.y = (Math.random() - 0.5) * PARTICLE_SPREAD_Y;
            sprite.position.z = (Math.random() - 0.5) * PARTICLE_SPREAD_Z;

            const scale = 0.5 + Math.random() * 2.0;
            sprite.scale.set(scale, scale, 1);

            sprite.userData = {
                speed: 0.05 + Math.random() * 0.1,
                type: Math.floor(Math.random() * 3),
                offset: Math.random() * 100,
                amp: 0.5 + Math.random() * 2
            };

            sprite.material.opacity = 0.1 + Math.random() * 0.4;
            particles.add(sprite);
        }
        scene.add(particles);

        const clock = new THREE.Clock();

        // Store in StateManager
        StateManager.setSceneObjects(scene, camera, renderer, particles, clock);
        StateManager.set('isPageVisible', true);

        // Resize handler
        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                const { camera, renderer } = StateManager.getSceneObjects();
                camera.aspect = window.innerWidth / window.innerHeight;
                camera.updateProjectionMatrix();
                renderer.setSize(window.innerWidth, window.innerHeight);
            }, window.CONSTANTS.RESIZE_DEBOUNCE);
        });

        this._animate();
    },

    /**
     * Animation loop.
     */
    _animate() {
        if (!StateManager.get('isPageVisible')) return;

        const { scene, camera, renderer, particles, clock } = StateManager.getSceneObjects();
        const { PARTICLE_SPREAD_X, PARTICLE_RESET_Y } = window.CONSTANTS;

        const animationFrameId = requestAnimationFrame(() => this._animate());
        StateManager.set('animationFrameId', animationFrameId);

        const time = clock.getElapsedTime();

        particles.children.forEach(sprite => {
            const d = sprite.userData;

            sprite.position.y -= d.speed;

            if (d.type === 0) {
                sprite.position.x += Math.sin(time * 0.5 + d.offset) * 0.02 * d.amp;
            } else if (d.type === 1) {
                sprite.position.x += Math.cos(time * 0.4 + d.offset) * 0.02 * d.amp;
            } else {
                sprite.position.x += Math.sin(time * 0.3) * 0.01 + Math.cos(time * 0.6) * 0.01;
            }

            sprite.material.rotation += 0.005;

            if (sprite.position.y < -PARTICLE_RESET_Y) {
                sprite.position.y = PARTICLE_RESET_Y;
                sprite.position.x = (Math.random() - 0.5) * PARTICLE_SPREAD_X;
            }

            const isLight = document.body.classList.contains('light-mode');
            const targetColor = isLight ? new THREE.Color(0x64748b) : new THREE.Color(0xccf0ff);
            sprite.material.color.lerp(targetColor, 0.1);
            sprite.material.opacity = isLight ? 0.2 : 0.3;
        });

        renderer.render(scene, camera);
    },

    /**
     * Handles page visibility for performance.
     */
    initPerformanceOptimization() {
        document.addEventListener('visibilitychange', () => {
            const isVisible = !document.hidden;
            StateManager.set('isPageVisible', isVisible);

            const { clock } = StateManager.getSceneObjects();
            if (isVisible) {
                clock.start();
                this._animate();
            } else {
                clock.stop();
                const animationFrameId = StateManager.get('animationFrameId');
                if (animationFrameId) cancelAnimationFrame(animationFrameId);
            }
        });
    }
};

window.ParticleEngine = ParticleEngine;
