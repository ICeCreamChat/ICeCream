/**
 * ICeCream - CursorEffects Module (Ported from MathSolver)
 * Copyright (c) 2026 ICeCreamChat
 * Licensed under the MIT License.
 *
 * Handles click explosion particle effects.
 */
const CursorEffects = {
    /**
     * Creates math symbol explosion at click position.
     */
    createExplosion(x, y) {
        const { MATH_SYMBOLS, EXPLOSION_PARTICLE_COUNT, EXPLOSION_VELOCITY_MIN, EXPLOSION_VELOCITY_MAX } = window.CONSTANTS;
        const themeColor = getComputedStyle(document.body).color;

        for (let i = 0; i < EXPLOSION_PARTICLE_COUNT; i++) {
            const el = document.createElement('div');
            el.classList.add('math-particle-dom');
            el.textContent = MATH_SYMBOLS[Math.floor(Math.random() * MATH_SYMBOLS.length)];
            el.style.color = themeColor;
            document.body.appendChild(el);

            el.style.left = `${x}px`;
            el.style.top = `${y}px`;

            const angle = Math.random() * Math.PI * 2;
            const velocity = EXPLOSION_VELOCITY_MIN + Math.random() * (EXPLOSION_VELOCITY_MAX - EXPLOSION_VELOCITY_MIN);
            const tx = Math.cos(angle) * velocity + 'px';
            const ty = Math.sin(angle) * velocity + 'px';
            const rot = (Math.random() - 0.5) * 360 + 'deg';

            el.style.setProperty('--tx', tx);
            el.style.setProperty('--ty', ty);
            el.style.setProperty('--rot', rot);

            setTimeout(() => el.remove(), 1000);
        }
    },

    /**
     * Initializes click listener for explosion effects.
     */
    init() {
        document.addEventListener('mousedown', (e) => {
            if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') {
                this.createExplosion(e.clientX, e.clientY);
            }
        });
    }
};

window.CursorEffects = CursorEffects;
