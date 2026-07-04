#!/bin/bash
set -e 

docker compose build

docker save -o tts.tar tts:latest

scp -i ~/.ssh/id_tx ./tts.tar root@82.156.247.203:/tts