# Stage 1: Build stage
FROM --platform=linux/amd64 node:24-slim AS builder

WORKDIR /app

# Copy package configuration files
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies) to build TypeScript
RUN npm ci

# Copy configuration and source files
COPY tsconfig.json build.js eslint.config.js ./
COPY src/ ./src

# Compile the TypeScript files (builds to dist/)
RUN npm run build

# Stage 2: Runtime stage
FROM --platform=linux/amd64 node:24-slim AS runner

# Install FFmpeg and FFprobe securely
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package configuration files
COPY package.json package-lock.json ./

# Install only production dependencies to minimize image size and attack surface
RUN npm ci --omit=dev

# Copy compiled files from the build stage
COPY --from=builder /app/dist ./dist

# Create the temporary working directory and set ownership to the non-root node user
RUN mkdir -p /tmp/audiobook && chown -R node:node /tmp/audiobook

# Switch to the non-root node user
USER node

# Expose the application port
EXPOSE 3000

# Set default runtime environment variables
ENV PORT=3000
ENV HOST=0.0.0.0
ENV TMP_ROOT=/tmp/audiobook
ENV FFMPEG_PATH=ffmpeg
ENV FFPROBE_PATH=ffprobe

CMD ["node", "dist/server.js"]
