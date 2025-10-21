#!/bin/bash

# Docker build script for audio-file-decoder
# Makes it easy to build artifacts using Docker

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

function print_usage() {
    echo "Usage: $0 [command]"
    echo ""
    echo "Commands:"
    echo "  full        - Full build from scratch (downloads deps, builds FFmpeg, WASM, and JS)"
    echo "  quick       - Quick build (assumes FFmpeg deps already built)"
    echo "  artifacts   - Extract built artifacts to ./dist and ./decode-audio.wasm"
    echo "  dev         - Start development container with interactive shell"
    echo "  clean       - Remove Docker images and build cache"
    echo "  help        - Show this help message"
    echo ""
}

function full_build() {
    echo -e "${GREEN}Starting full build...${NC}"
    docker build --target stage_js_build -t audio-file-decoder:latest .
    echo -e "${GREEN}✓ Full build complete!${NC}"
    echo -e "${YELLOW}Run '$0 artifacts' to extract build artifacts${NC}"
}

function quick_build() {
    echo -e "${GREEN}Starting quick build (using docker-compose)...${NC}"
    docker-compose run --rm quick-build
    echo -e "${GREEN}✓ Quick build complete!${NC}"
}

function extract_artifacts() {
    echo -e "${GREEN}Extracting artifacts...${NC}"

    # Create a temporary container
    CONTAINER_ID=$(docker create audio-file-decoder:latest)

    # Extract artifacts (everything is in dist/)
    docker cp "$CONTAINER_ID:/src/dist" ./dist

    # Cleanup
    docker rm "$CONTAINER_ID"

    echo -e "${GREEN}✓ Artifacts extracted to ./dist${NC}"
    echo -e "${YELLOW}Contents: dist/audio-file-decoder.js, dist/audio-file-decoder.d.ts, dist/decode-audio.wasm${NC}"
}

function dev_shell() {
    echo -e "${GREEN}Starting development container...${NC}"
    docker-compose run --rm dev
}

function clean() {
    echo -e "${YELLOW}Cleaning Docker images and cache...${NC}"
    docker-compose down --rmi all 2>/dev/null || true
    docker rmi audio-file-decoder:latest 2>/dev/null || true
    docker builder prune -f
    echo -e "${GREEN}✓ Cleanup complete!${NC}"
}

# Main script
case "${1:-}" in
    full)
        full_build
        ;;
    quick)
        quick_build
        ;;
    artifacts)
        extract_artifacts
        ;;
    dev)
        dev_shell
        ;;
    clean)
        clean
        ;;
    help|--help|-h|"")
        print_usage
        ;;
    *)
        echo -e "${RED}Unknown command: $1${NC}"
        print_usage
        exit 1
        ;;
esac
