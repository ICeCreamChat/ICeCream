// HISTORY COLLAPSE DEBUG UTILITY
// Add this to browser console to manually test and debug

console.log('=== HISTORY COLLAPSE DEBUGGER ===');

function debugHistoryCollapse() {
    const container = document.getElementById('manim-history-root');

    if (!container) {
        console.error('❌ Container #manim-history-root not found!');
        return;
    }

    console.log('✅ Container found:', container);
    console.log('Current classes:', container.className);
    console.log('Has expanded class?', container.classList.contains('expanded'));

    const header = container.querySelector('.history-list-header');
    if (!header) {
        console.error('❌ Header .history-list-header not found!');
        return;
    }

    console.log('✅ Header found:', header);
    console.log('Header onclick:', header.onclick);
    console.log('Header getAttribute onclick:', header.getAttribute('onclick'));

    // Test computed styles
    const computedStyle = window.getComputedStyle(container);
    console.log('Computed height:', computedStyle.height);
    console.log('Computed max-height:', computedStyle.maxHeight);
    console.log('Computed overflow:', computedStyle.overflow);

    // Test manual toggle
    console.log('\n--- Testing manual toggle ---');
    const before = container.className;
    container.classList.toggle('expanded');
    const after = container.className;
    console.log('Before:', before);
    console.log('After:', after);
    console.log('Toggle worked?', before !== after);

    // Check if CSS transition exists
    console.log('\nTransition:', computedStyle.transition);

    return {
        container,
        header,
        hasExpanded: container.classList.contains('expanded'),
        computedStyle
    };
}

// Run immediately
const result = debugHistoryCollapse();

console.log('\n=== MANUAL TEST ===');
console.log('Run this command to toggle manually:');
console.log('document.getElementById("manim-history-root").classList.toggle("expanded")');
