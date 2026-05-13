"""Last-resort deterministic rescue scenes for hard quality failures.

The normal path remains LLM-authored code. These scenes are only used after the
agent has already failed a hard semantic, static, or preview quality gate.
"""

from __future__ import annotations

from typing import Any

from .scene_runtime import SCENE_RUNTIME_CODE


def _kind(brief: dict[str, Any] | None) -> str:
    spec = (brief or {}).get("storyboardSpec") or (brief or {}).get("spec") or {}
    return str(spec.get("kind") or spec.get("animation_type") or (brief or {}).get("animation_type") or "")


def _message(brief: dict[str, Any] | None) -> str:
    return str((brief or {}).get("message") or "")


def _wrap(body: str) -> str:
    return SCENE_RUNTIME_CODE + "\n\nclass MainScene(SafeScene, Scene):\n    def construct(self):\n" + body


def rescue_scene_code(brief: dict[str, Any] | None, reason: str = "") -> str:
    kind = _kind(brief)
    message = _message(brief)
    if kind == "geometry_circle" or "圆" in message:
        return _circle_scene()
    if kind == "triangle" or "三角" in message:
        return _triangle_scene()
    if kind == "function_graph" or "正弦" in message or "余弦" in message:
        return _function_scene("cos" if "余弦" in message or "cos" in message.lower() else "sin")
    if kind in {"data_chart", "bar_chart", "line_chart"} or any(token in message for token in ("柱状图", "销量", "数据")):
        return _bar_chart_scene()
    if kind in {"motion_path", "physics_motion"} or any(token in message for token in ("小球", "抛物", "运动")):
        return _projectile_scene()
    if kind in {"flow_process", "process_flow"} or "TCP" in message.upper() or "握手" in message:
        return _tcp_scene()
    return ""


def _circle_scene() -> str:
    return _wrap(r'''        self.add(make_panel())
        header, title, subtitle = make_header("圆形的基本元素", "圆心、半径与直径")
        banner = make_step_banner("步骤 1：绘制圆形主体")
        circle = Circle(radius=1.75, color="#0284C7", stroke_width=9)
        center = Dot(ORIGIN, color="#F97316", radius=0.08)
        radius = Line(ORIGIN, RIGHT * 1.75, color="#F97316", stroke_width=5)
        diameter = Line(LEFT * 1.75, RIGHT * 1.75, color="#16A34A", stroke_width=5)
        radius_label = SafeText("半径 r", font_size=26, color="#B45309").next_to(radius, DOWN, buff=0.18)
        diameter_label = SafeText("直径 d = 2r", font_size=26, color="#15803D").next_to(diameter, UP, buff=0.18)
        visual = place_visual(VGroup(circle, center, radius, diameter, radius_label, diameter_label))
        summary = make_summary("圆上所有点到圆心的距离都等于半径。")
        self.add(header, banner, visual, summary)
        self.safe_play(Create(circle), FadeIn(center), Create(radius), Write(radius_label))
        self.safe_play(Create(diameter), Write(diameter_label), FadeIn(summary))
        self.wait(1.2)
''')


def _triangle_scene() -> str:
    return _wrap(r'''        self.add(make_panel())
        header, title, subtitle = make_header("三角形的基本构成", "三条边、三个顶点、三个角")
        banner = make_step_banner("步骤 1：绘制三角形主体")
        a = LEFT * 2.7 + DOWN * 1.15
        b = RIGHT * 2.7 + DOWN * 1.15
        c = UP * 1.85
        triangle = Polygon(a, b, c, color="#0284C7", stroke_width=8)
        vertices = VGroup(Dot(a, color="#F97316"), Dot(b, color="#F97316"), Dot(c, color="#F97316"))
        labels = VGroup(
            SafeText("A", font_size=30).next_to(a, DOWN + LEFT, buff=0.12),
            SafeText("B", font_size=30).next_to(b, DOWN + RIGHT, buff=0.12),
            SafeText("C", font_size=30).next_to(c, UP, buff=0.12),
        )
        side_labels = VGroup(
            SafeText("AB", font_size=25, color="#15803D").next_to(Line(a, b), DOWN, buff=0.16),
            SafeText("BC", font_size=25, color="#15803D").move_to((b + c) / 2 + RIGHT * 0.38),
            SafeText("CA", font_size=25, color="#15803D").move_to((c + a) / 2 + LEFT * 0.38),
        )
        visual = place_visual(VGroup(triangle, vertices, labels, side_labels))
        summary = make_summary("三角形由三条线段首尾相连围成。")
        self.add(header, banner, visual, summary)
        self.safe_play(Create(triangle), FadeIn(vertices), Write(labels))
        self.safe_play(Write(side_labels), FadeIn(summary))
        self.wait(1.2)
''')


def _function_scene(function_name: str) -> str:
    title = "余弦函数图像" if function_name == "cos" else "正弦函数图像"
    formula = "y = cos(x)" if function_name == "cos" else "y = sin(x)"
    fn = "np.cos" if function_name == "cos" else "np.sin"
    return _wrap(f'''        self.add(make_panel())
        header, title, subtitle = make_header("{title}", "一个周期内的关键点")
        banner = make_step_banner("步骤 1：建立坐标系")
        axes = Axes(
            x_range=[0, 2 * PI, PI / 2],
            y_range=[-1.25, 1.25, 0.5],
            x_length=8.8,
            y_length=4.2,
            axis_config={{"color": "#334155", "stroke_width": 3}},
            tips=True,
        )
        graph = axes.plot(lambda x: {fn}(x), x_range=[0, 2 * PI], color="#0284C7", stroke_width=7)
        x_labels = VGroup()
        for value, label in [(0, "0"), (PI/2, "π/2"), (PI, "π"), (3*PI/2, "3π/2"), (2*PI, "2π")]:
            x_labels.add(SafeText(label, font_size=24).next_to(axes.c2p(value, 0), DOWN, buff=0.14))
        y_labels = VGroup(
            SafeText("1", font_size=24).next_to(axes.c2p(0, 1), LEFT, buff=0.14),
            SafeText("-1", font_size=24).next_to(axes.c2p(0, -1), LEFT, buff=0.14),
        )
        formula_label = SafeText("{formula}", font_size=34, color="#B45309").next_to(axes, UP, buff=0.25)
        points = VGroup()
        for x in [0, PI/2, PI, 3*PI/2, 2*PI]:
            points.add(Dot(axes.c2p(x, {fn}(x)), color="#F97316", radius=0.055))
        visual = place_visual(VGroup(axes, graph, x_labels, y_labels, formula_label, points))
        summary = make_summary("曲线按周期 2π 重复，振幅为 1。")
        self.add(header, banner, axes, x_labels, y_labels, formula_label)
        self.safe_play(Create(graph), FadeIn(points))
        self.safe_play(FadeIn(summary))
        self.wait(1.2)
''')


def _bar_chart_scene() -> str:
    return _wrap(r'''        self.add(make_panel())
        header, title, subtitle = make_header("三个月销量柱状图", "对比 1 月、2 月、3 月")
        banner = make_step_banner("步骤 1：绘制柱状图")
        axes = Axes(x_range=[0, 4, 1], y_range=[0, 60, 10], x_length=8.2, y_length=4.2, axis_config={"color": "#334155", "stroke_width": 3}, tips=True)
        data = [("1月", 30), ("2月", 45), ("3月", 25)]
        bars = VGroup()
        labels = VGroup()
        for index, (month, value) in enumerate(data, start=1):
            height = value / 60 * 4.2
            bar = Rectangle(width=0.75, height=height, fill_color="#0284C7", fill_opacity=0.88, stroke_color="#0E7490", stroke_width=2)
            bar.move_to(axes.c2p(index, value / 2))
            bars.add(bar)
            labels.add(SafeText(month, font_size=24).next_to(axes.c2p(index, 0), DOWN, buff=0.14))
            labels.add(SafeText(str(value), font_size=24, color="#B45309").next_to(bar, UP, buff=0.12))
        axis_labels = VGroup(SafeText("月份", font_size=24).next_to(axes.x_axis, RIGHT), SafeText("销量", font_size=24).next_to(axes.y_axis, UP))
        visual = place_visual(VGroup(axes, bars, labels, axis_labels))
        summary = make_summary("2 月销量最高，3 月需要重点关注。")
        self.add(header, banner, axes, axis_labels, labels)
        self.safe_play(LaggedStart(*[GrowFromEdge(bar, DOWN) for bar in bars], lag_ratio=0.18))
        self.safe_play(FadeIn(summary))
        self.wait(1.2)
''')


def _projectile_scene() -> str:
    return _wrap(r'''        self.add(make_panel())
        header, title, subtitle = make_header("小球抛物线运动", "轨迹、速度与重力")
        banner = make_step_banner("步骤 1：观察抛物线轨迹")
        axes = Axes(x_range=[0, 6, 1], y_range=[0, 4, 1], x_length=8.4, y_length=4.4, axis_config={"color": "#CBD5E1", "stroke_width": 2}, tips=False)
        path = ParametricFunction(lambda t: axes.c2p(t, -0.28 * (t - 3) ** 2 + 3.0), t_range=[0.25, 5.75], color="#0284C7", stroke_width=7)
        ball = Dot(path.get_start(), color="#F97316", radius=0.10)
        velocity = Arrow(ORIGIN, RIGHT * 0.9 + UP * 0.45, color="#16A34A", buff=0).next_to(ball, UP, buff=0.2)
        gravity = Arrow(UP * 0.7, DOWN * 0.15, color="#DC2626", buff=0).move_to(RIGHT * 3.6 + UP * 1.2)
        labels = VGroup(
            SafeText("速度方向", font_size=24, color="#15803D").next_to(velocity, UP, buff=0.10),
            SafeText("重力向下", font_size=24, color="#B91C1C").next_to(gravity, RIGHT, buff=0.12),
        )
        visual = place_visual(VGroup(axes, path, ball, velocity, gravity, labels))
        summary = make_summary("水平速度保持，竖直方向受重力影响形成抛物线。")
        self.add(header, banner, axes, path, ball, velocity, gravity, labels)
        self.safe_play(MoveAlongPath(ball, path), run_time=2.2)
        self.safe_play(FadeIn(summary))
        self.wait(1.0)
''')


def _tcp_scene() -> str:
    return _wrap(r'''        self.add(make_panel())
        header, title, subtitle = make_header("TCP 三次握手", "建立可靠连接")
        banner = make_step_banner("步骤 1：SYN 请求")
        client = RoundedRectangle(width=2.2, height=0.9, corner_radius=0.14, fill_color="#E0F2FE", fill_opacity=1, stroke_color="#0284C7")
        server = client.copy()
        client.move_to(LEFT * 3.0)
        server.move_to(RIGHT * 3.0)
        labels = VGroup(SafeText("客户端", font_size=26).move_to(client), SafeText("服务器", font_size=26).move_to(server))
        arrows = VGroup(
            Arrow(client.get_right(), server.get_left(), color="#0284C7", buff=0.15),
            Arrow(server.get_left() + DOWN * 0.35, client.get_right() + DOWN * 0.35, color="#16A34A", buff=0.15),
            Arrow(client.get_right() + DOWN * 0.7, server.get_left() + DOWN * 0.7, color="#F97316", buff=0.15),
        )
        arrow_labels = VGroup(
            SafeText("1. SYN", font_size=24, color="#0284C7").next_to(arrows[0], UP),
            SafeText("2. SYN + ACK", font_size=24, color="#15803D").next_to(arrows[1], DOWN),
            SafeText("3. ACK", font_size=24, color="#B45309").next_to(arrows[2], DOWN),
        )
        visual = place_visual(VGroup(client, server, labels, arrows, arrow_labels))
        summary = make_summary("三次交互确认双方收发能力，连接建立完成。")
        self.add(header, banner, client, server, labels)
        self.safe_play(GrowArrow(arrows[0]), FadeIn(arrow_labels[0]))
        self.safe_play(GrowArrow(arrows[1]), FadeIn(arrow_labels[1]))
        self.safe_play(GrowArrow(arrows[2]), FadeIn(arrow_labels[2]), FadeIn(summary))
        self.wait(1.2)
''')
