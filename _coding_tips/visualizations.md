---
layout: default
title: Tips for python visualizations
# permalink: /coding-tips/visualizations/
---
Some useful tips for visualizing data in python.

### Create a random colormap with many different colors
This is useful for visualizing state vectors with many different elements.
```
from matplotlib.colors import ListedColormap
num_colors = 13000
random_cmap = ListedColormap(np.random.rand(num_colors,3))
labels["StateVector"].plot(cmap=random_cmap)
```