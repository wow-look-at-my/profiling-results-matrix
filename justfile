[private]
help:
	@just --list

# Install deps, typecheck (tsc, noEmit), and bundle the action to dist/index.js
build:
	pnpm install
	pnpm tsc
	pnpm esbuild src/index.ts --bundle --platform=node --target=node24 --outfile=dist/index.js

# Run the unit tests (pure logic: render, config validation, store retry loop)
test:
	pnpm install
	pnpm tsx --test src/*.test.ts
