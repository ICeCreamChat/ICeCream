/**
 * ICeCream - TTSHandler Module (Ported from MathSolver)
 * Copyright (c) 2026 ICeCreamChat
 * Licensed under the MIT License.
 *
 * Handles Text-to-Speech functionality.
 */
const TTSHandler = {
    /**
     * Toggles TTS on/off.
     */
    toggle() {
        const isEnabled = !StateManager.get('isTTSEnabled');
        StateManager.set('isTTSEnabled', isEnabled);

        const label = document.getElementById('tts-label');
        if (label) {
            label.innerHTML = isEnabled
                ? `<i data-lucide="volume-2" style="width: 16px;"></i> 朗读: 开`
                : `<i data-lucide="volume-x" style="width: 16px;"></i> 朗读: 关`;
            if (window.lucide) window.lucide.createIcons();
        }

        if (!isEnabled) this.stop();

        const dropdown = document.getElementById('dropdownMenu');
        if (dropdown) dropdown.classList.remove('show');
    },

    /**
     * Speaks the given text using Web Speech API.
     */
    speak(text) {
        if (!StateManager.get('isTTSEnabled') || !('speechSynthesis' in window)) return;

        const cleanText = text
            .replace(/[\$\*\#\`]/g, '')
            .replace(/\[.*?\]/g, '')
            .replace(/\n/g, '，');

        const utterance = new SpeechSynthesisUtterance(cleanText);
        const voices = window.speechSynthesis.getVoices();

        const bestVoice = voices.find(v =>
            v.lang.includes('zh') && (v.name.includes('Microsoft') || v.name.includes('Google'))
        ) || voices.find(v => v.lang.includes('zh'));

        if (bestVoice) {
            utterance.voice = bestVoice;
            utterance.rate = 1.1;
        }

        window.speechSynthesis.speak(utterance);
    },

    /**
     * Stops any ongoing speech.
     */
    stop() {
        if ('speechSynthesis' in window) {
            window.speechSynthesis.cancel();
        }
    }
};

window.TTSHandler = TTSHandler;
