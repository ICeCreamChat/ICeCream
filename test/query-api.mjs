async function test() {
    const response = await fetch('http://localhost:3000/api/geogebra/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: "已知 \\triangle ABC 的三个内角都小于 120^\\circ，在三角形内部找一点 P，使得点 P 到三个顶点的距离之和 PA + PB + PC 最小",
            canvas: { elements: [], expressions: [] },
            selectedObjects: [],
            preferredPerspective: 'G',
        }),
    });
    const payload = await response.json();
    console.log(JSON.stringify(payload, null, 2));
}

test().catch(console.error);
