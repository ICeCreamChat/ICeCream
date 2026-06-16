/**
 * 移动端智能助手抽屉控制器
 * 负责底部抽屉的展开/收起、拖动手势、高度调整
 */

export function createMobileDrawerController() {
    let drawerElement = null;
    let overlayElement = null;
    let tabElement = null;
    let contentElement = null;
    let isDragging = false;
    let startY = 0;
    let currentTranslateY = 0;
    let drawerHeight = 0;

    /**
     * 初始化抽屉控制器
     */
    function init() {
        if (typeof window === 'undefined' || typeof document === 'undefined') {
            return; // Node.js 环境不初始化
        }
        if (window.innerWidth >= 768) {
            return; // 桌面端不初始化
        }

        drawerElement = document.querySelector('.tt-smart-insight-rail-mobile');
        overlayElement = document.querySelector('.tt-smart-assistant-overlay');
        tabElement = document.querySelector('.tt-smart-drawer-tab');
        contentElement = document.querySelector('.tt-smart-drawer-content');

        if (!drawerElement || !overlayElement || !tabElement) {
            return;
        }

        bindEvents();
    }

    /**
     * 绑定事件监听
     */
    function bindEvents() {
        // 点击标签打开抽屉
        tabElement?.addEventListener('click', () => openDrawer('half'));

        // 点击遮罩关闭抽屉
        overlayElement?.addEventListener('click', closeDrawer);

        // 点击关闭按钮
        const closeBtn = document.querySelector('.tt-smart-drawer-close');
        closeBtn?.addEventListener('click', closeDrawer);

        // 拖动手势
        const handle = document.querySelector('.tt-smart-drawer-handle');
        if (handle) {
            handle.addEventListener('touchstart', handleTouchStart, { passive: false });
            handle.addEventListener('mousedown', handleTouchStart);
        }

        // 监听窗口大小变化
        window.addEventListener('resize', handleResize);
    }

    /**
     * 打开抽屉
     * @param {string} height - 高度模式: 'peek' | 'half' | 'full'
     */
    function openDrawer(height = 'half') {
        if (!drawerElement || !overlayElement || !tabElement) return;

        drawerElement.classList.add('is-open');
        drawerElement.setAttribute('data-drawer-height', height);
        overlayElement.classList.add('is-visible');
        tabElement.style.display = 'none';
        document.body.classList.add('tt-drawer-open');

        // 触发打开事件
        drawerElement.dispatchEvent(new CustomEvent('drawer:opened', { detail: { height } }));
    }

    /**
     * 关闭抽屉
     */
    function closeDrawer() {
        if (!drawerElement || !overlayElement || !tabElement) return;

        drawerElement.classList.remove('is-open');
        drawerElement.removeAttribute('data-drawer-height');
        overlayElement.classList.remove('is-visible');
        tabElement.style.display = 'inline-flex';
        document.body.classList.remove('tt-drawer-open');

        // 触发关闭事件
        drawerElement.dispatchEvent(new CustomEvent('drawer:closed'));
    }

    /**
     * 设置抽屉高度
     * @param {string} height - 高度模式
     */
    function setDrawerHeight(height) {
        if (!drawerElement) return;
        drawerElement.setAttribute('data-drawer-height', height);

        // 触发高度变化事件
        drawerElement.dispatchEvent(new CustomEvent('drawer:heightChanged', { detail: { height } }));
    }

    /**
     * 处理触摸/鼠标按下开始
     */
    function handleTouchStart(e) {
        if (!drawerElement) return;

        isDragging = true;
        startY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;
        drawerHeight = drawerElement.offsetHeight;

        // 获取当前 transform 值
        const transform = window.getComputedStyle(drawerElement).transform;
        if (transform !== 'none') {
            const matrix = new DOMMatrix(transform);
            currentTranslateY = matrix.m42;
        } else {
            currentTranslateY = 0;
        }

        drawerElement.classList.add('is-dragging');

        // 添加移动和结束监听
        document.addEventListener('touchmove', handleTouchMove, { passive: false });
        document.addEventListener('touchend', handleTouchEnd);
        document.addEventListener('mousemove', handleTouchMove);
        document.addEventListener('mouseup', handleTouchEnd);

        e.preventDefault();
    }

    /**
     * 处理触摸/鼠标移动
     */
    function handleTouchMove(e) {
        if (!isDragging || !drawerElement) return;

        const currentY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
        const deltaY = currentY - startY;
        const newTranslateY = Math.max(0, Math.min(drawerHeight, deltaY));

        // 直接设置 transform
        drawerElement.style.transform = `translateY(${newTranslateY}px)`;

        e.preventDefault();
    }

    /**
     * 处理触摸/鼠标抬起结束
     */
    function handleTouchEnd(e) {
        if (!isDragging || !drawerElement) return;

        const currentY = e.type === 'touchend' ? e.changedTouches[0].clientY : e.clientY;
        const deltaY = currentY - startY;
        const velocity = Math.abs(deltaY);

        // 清理拖动状态
        isDragging = false;
        drawerElement.classList.remove('is-dragging');
        drawerElement.style.transform = '';

        // 移除监听
        document.removeEventListener('touchmove', handleTouchMove);
        document.removeEventListener('touchend', handleTouchEnd);
        document.removeEventListener('mousemove', handleTouchMove);
        document.removeEventListener('mouseup', handleTouchEnd);

        // 根据拖动距离和速度决定目标高度
        const viewportHeight = window.innerHeight;
        const currentPercent = (deltaY / viewportHeight) * 100;

        if (deltaY > drawerHeight * 0.7 || velocity > 50) {
            // 向下拖动超过 70% 或快速滑动 -> 关闭
            closeDrawer();
        } else if (currentPercent < 15) {
            // 向上拖动到顶部 -> 全屏
            setDrawerHeight('full');
        } else if (currentPercent < 40) {
            // 中等位置 -> 半屏
            setDrawerHeight('half');
        } else {
            // 其他 -> 保持当前高度或回到半屏
            setDrawerHeight('half');
        }
    }

    /**
     * 处理窗口大小变化
     */
    function handleResize() {
        if (typeof window === 'undefined') {
            return; // Node.js 环境不处理
        }
        if (window.innerWidth >= 768) {
            // 切换到桌面端，清理移动端状态
            cleanup();
        } else if (window.innerWidth < 768 && !drawerElement) {
            // 切换到移动端，重新初始化
            init();
        }
    }

    /**
     * 清理控制器
     */
    function cleanup() {
        if (typeof document === 'undefined') {
            return; // Node.js 环境不执行清理
        }
        if (drawerElement?.classList.contains('is-open')) {
            closeDrawer();
        }

        const handle = document.querySelector('.tt-smart-drawer-handle');
        if (handle) {
            handle.removeEventListener('touchstart', handleTouchStart);
            handle.removeEventListener('mousedown', handleTouchStart);
        }

        document.removeEventListener('touchmove', handleTouchMove);
        document.removeEventListener('touchend', handleTouchEnd);
        document.removeEventListener('mousemove', handleTouchMove);
        document.removeEventListener('mouseup', handleTouchEnd);
        window.removeEventListener('resize', handleResize);

        drawerElement = null;
        overlayElement = null;
        tabElement = null;
        contentElement = null;
    }

    /**
     * 销毁控制器
     */
    function destroy() {
        cleanup();
    }

    /**
     * 获取抽屉状态
     */
    function getState() {
        return {
            isOpen: drawerElement?.classList.contains('is-open') || false,
            height: drawerElement?.getAttribute('data-drawer-height') || null,
            isMobile: window.innerWidth < 768,
        };
    }

    return {
        init,
        openDrawer,
        closeDrawer,
        setDrawerHeight,
        getState,
        destroy,
    };
}
