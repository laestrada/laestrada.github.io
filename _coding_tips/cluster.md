---
layout: default
title: Tips for the cluster
# permalink: /coding-tips/cluster/
---

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

### Connecting VSCode to a compute node using tunneling
VSCode has a handy extension called [Remote Explorer](https://marketplace.visualstudio.com/items?itemName=ms-vscode.remote-explorer) that allows you to connect to a remote machine via ssh with the click of a button and have all the amenities VSCode offers, including use of jupyter notebooks, text editing, etc. However, when connecting to the cluster one can only connect to the login node via ssh. The login node is only for barebones access to the cluster and should not be used for compute heavy tasks like using a jupyter notebook.

Ideally one would like to be able to connect VSCode to a compute node allocated using `salloc` or `sbatch`, so that the amount of memory and cores can be specified for one's individual needs. This can now be done using secure tunnels via the [Remote - Tunnels](https://marketplace.visualstudio.com/items?itemName=ms-vscode.remote-server) extension and a few additional steps outlined below:

1. First ssh onto the cluster to your home directory.
1. Install the [vscode-cli](https://code.visualstudio.com/docs/editor/command-line):
```
$ curl -Lk 'https://code.visualstudio.com/sha/download?build=stable&os=cli-alpine-x64' --output vscode_cli.tar.gz
$ tar -xf vscode_cli.tar.gz
```
1. Create an sbatch script that will create a tunnel from cannon accessible from your local computer (I named mine tunnel.sh):
```
#!/bin/bash

#SBATCH -c 1
#SBATCH --mem=4000
#SBATCH -t 0-6:00
#SBATCH -p huce_intel,huce_cascade,seas_compute
#SBATCH -o tunnel.log

./code tunnel --accept-server-license-terms
```
Configure the memory, cores, partition, and time to suit your needs.

1. Open `tunnel.log`, go to the link, and enter the access code provided. The message in `tunnel.log` will be something like: `To grant access to the server, please log into https://github.com/login/device and use code B123-2456`.
1. Authorize the account access, open vscode (locally), and go to the Remote Explorer extension (with Remote Tunnels installed). 
1. Press the button under `Tunnels` that corresponds with your newly created tunnel.
Congratulations you should now be connected -- have fun!
