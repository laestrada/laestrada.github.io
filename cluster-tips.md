---
layout: page
title: Coding
permalink: /coding-tips/
---

# Helpful Commands
I use this page as a repository of helpful commands and coding tips that I want to keep handy.

## Tips for the cluster

### unix/ bash
- `rsync`: move files from local drive to remote
- `find . -exec touch {} \;`: touch all files within a directory 
### slurm
- `salloc`: starts an interactive job
- `sshare`: prints fairshare score
#### slurm flags 
- `-p` controls partition (eg. huce_cascade, huce_intel)
- `-c` controls cpus per task 
- `-m` minimum memory per core
- `-d` controls dependencies