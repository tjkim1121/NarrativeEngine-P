#!/bin/bash
echo "Installing dependencies..."
cd "$(dirname "$0")"
npm install
echo "Starting the application..."
(sleep 3 && xdg-open http://localhost:5173) &
npm run dev
