import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    build: {
        outDir: 'public/js/studio',
        emptyOutDir: false,
        sourcemap: false,
        lib: {
            entry: 'src/manim-studio/main.jsx',
            name: 'ManimStudioCanvas',
            formats: ['iife'],
            fileName: () => 'manim-studio-canvas.js',
        },
        rollupOptions: {
            output: {
                inlineDynamicImports: true,
            },
        },
    },
});
