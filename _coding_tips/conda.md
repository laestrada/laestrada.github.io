---
layout: default
title: Conda Tips
# permalink: /coding-tips/conda/
---
# Conda
## Generally useful commands

## Exporting environments
- `conda update --all`: update all dependencies in env
- `conda env export > environment.yml`: export environment Note: use the --no-builds flag if planning to switch to a different operating system.

## Installing conda environments from different environments to macos M1

Some conda environment dependencies don't yet have arm64 support, which necessitates creating an x86 conda environment on macOS.

To do so:
1. Run: 
```
CONDA_SUBDIR=osx-64 conda create -n myenv_x86 python=3.9
conda activate myenv_x86
conda config --env --set subdir osx-64
```
This new environment will now be able to use dependencies with osx-64 builds. 

1. Then to install an existing environment.yml file into the new x86 environment run:
`conda env update --file environment.yml --prune`