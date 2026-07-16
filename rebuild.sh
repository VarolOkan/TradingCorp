#! /usr/bin/env bash

export HOST=10.9.200.188 
export PORT=8091
export REGISTRY_STORE_DRIVER=json # sqlite
export ENABLE_CRYPTO_AGENCY=false # Not fully implemented yet
export DATA_DIR=.my_data

npm run build && npm run dev:all

