
import matplotlib.pyplot as plt
import io

def render_math(formula, path):
    fig = plt.figure(figsize=(0.01, 0.01))
    fig.text(0, 0, f'$', fontsize=12)
    fig.savefig(path, format='png', dpi=150, bbox_inches='tight', pad_inches=0.05, transparent=True)
    plt.close(fig)

render_math('0.0 \le \text{Prob}(y > 1.7) \le 0.18', 'test_local_math.png')
print('Rendered')

