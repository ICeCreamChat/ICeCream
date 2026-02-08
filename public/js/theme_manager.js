/**
 * ICeCream - ThemeManager Module (Fixed)
 * Copyright (c) 2026 ICeCreamChat
 * Licensed under the MIT License.
 *
 * Handles theme switching (day/night mode) and mobile status bar.
 * 
 * IMPORTANT: This module respects user's manual theme choice stored in localStorage.
 * If user manually toggles theme, auto-switching is disabled permanently until cleared.
 */
const ThemeManager = {
    /**
     * Checks if user has manually set a theme preference
     * @returns {boolean}
     */
    isManuallySet() {
        return localStorage.getItem('theme') !== null;
    },

    /**
     * Checks Beijing time and auto-switches theme.
     * ONLY runs if user has NOT manually set a theme preference.
     */
    checkBeijingTime() {
        // If user has manually set theme, NEVER auto-switch
        if (this.isManuallySet()) {
            return;
        }

        const { DAY_START_HOUR, DAY_END_HOUR } = window.CONSTANTS || { DAY_START_HOUR: 7, DAY_END_HOUR: 18 };
        const date = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
        const hour = date.getHours();

        const wasLight = document.body.classList.contains('light-mode');

        if (hour >= DAY_START_HOUR && hour < DAY_END_HOUR) {
            document.body.classList.add('light-mode');
        } else {
            document.body.classList.remove('light-mode');
        }

        const isLight = document.body.classList.contains('light-mode');
        if (wasLight !== isLight || !window.hasInitializedTheme) {
            this.updateMobileStatusBar();
            window.hasInitializedTheme = true;
        }
    },

    /**
     * Toggles theme manually and SAVES to localStorage.
     * This stops auto-switching permanently.
     */
    toggleTheme() {
        document.body.classList.toggle('light-mode');
        const isLight = document.body.classList.contains('light-mode');

        // Save to localStorage - this permanently disables auto-switching
        localStorage.setItem('theme', isLight ? 'light' : 'dark');

        const dropdown = document.getElementById('dropdownMenu');
        if (dropdown) dropdown.classList.remove('show');

        this.updateMobileStatusBar();

        // Show feedback
        if (window.showToast) {
            window.showToast(isLight ? '已切换到浅色模式' : '已切换到深色模式', 'info');
        }
    },

    /**
     * Syncs mobile status bar color with current theme.
     */
    updateMobileStatusBar() {
        const isLight = document.body.classList.contains('light-mode');
        const themeColor = isLight ? '#f0f4f8' : '#050b14';

        let metaThemeColor = document.querySelector('meta[name="theme-color"]');
        if (!metaThemeColor) {
            metaThemeColor = document.createElement('meta');
            metaThemeColor.name = "theme-color";
            document.head.appendChild(metaThemeColor);
        }
        metaThemeColor.content = themeColor;

        let metaStatusStyle = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
        if (metaStatusStyle) {
            metaStatusStyle.content = isLight ? "default" : "black-translucent";
        }
    },

    /**
     * Loads saved theme from localStorage on startup.
     */
    loadSavedTheme() {
        const savedTheme = localStorage.getItem('theme');
        if (savedTheme === 'light') {
            document.body.classList.add('light-mode');
        } else if (savedTheme === 'dark') {
            document.body.classList.remove('light-mode');
        }
        // If no saved theme, don't modify - let checkBeijingTime handle it
    },

    /**
     * Initializes theme system.
     * - First loads saved theme preference
     * - Only auto-switches if no manual preference exists
     */
    init() {
        // Load user's saved preference FIRST
        this.loadSavedTheme();

        // Only run time-based check if no manual preference
        if (!this.isManuallySet()) {
            this.checkBeijingTime();
            // Set up interval for auto-switching (only if not manually set)
            setInterval(() => this.checkBeijingTime(), 60000);
        }

        this.updateMobileStatusBar();
        console.log('[ThemeManager] Initialized. Manual theme:', this.isManuallySet());
    }
};

window.ThemeManager = ThemeManager;
