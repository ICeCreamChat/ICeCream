import numpy as np
from manim import *

class RedCircleScene(Scene):
    def construct(self):
        """
        创建一个红色圆形的场景
        这是一个全新的场景，不涉及任何现有对象
        """
        
        # 创建一个红色的圆形
        # 使用 Circle 类创建圆形，设置半径为 1.5 以确保在屏幕内清晰可见
        # 设置颜色为红色，使用预定义的颜色名称 RED
        red_circle = Circle(
            radius=1.5,          # 设置半径大小
            color=RED,           # 设置颜色为红色
            fill_opacity=0.5,    # 设置填充不透明度，使圆形更醒目
            stroke_width=8       # 设置边框宽度，增强视觉效果
        )
        
        # 将圆形放置在屏幕中心
        # 默认位置就是 (0, 0, 0)，即屏幕中心
        red_circle.move_to(ORIGIN)
        
        # 让圆形从无到有逐渐显示
        self.play(Create(red_circle), run_time=2)
        
        # 保持显示一段时间
        self.wait(2)
        
        # 添加一个标签来说明这个圆形
        # 使用 Text 类而不是 MathTex，因为包含中文
        label = Text("红色圆形", font_size=36, color=WHITE)
        
        # 将标签放置在圆形的下方
        label.next_to(red_circle, DOWN, buff=0.5)
        
        # 添加标签到场景中
        self.play(Write(label), run_time=1)
        
        # 保持显示一段时间
        self.wait(2)
        
        # 添加额外的动画效果使场景更生动
        # 让圆形颜色从红色变为蓝色再变回红色
        self.play(red_circle.animate.set_color(BLUE), run_time=1.5)
        self.wait(0.5)
        self.play(red_circle.animate.set_color(RED), run_time=1.5)
        
        # 最后保持显示一段时间
        self.wait(2)

# 注意：这是完整的代码文件，可以直接运行
# 运行命令示例：manim -pql red_circle_scene.py RedCircleScene