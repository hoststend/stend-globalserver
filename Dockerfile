# syntax=docker/dockerfile:1

# Use official image as the base image
ARG BUN_VERSION=1.3.0
FROM oven/bun:${BUN_VERSION}-alpine

# Use production environment
ENV NODE_ENV=production
ENV BUN=production

# Prepare app directory before copying any files
WORKDIR /usr/src/app

# Install dependencies, and then copy all remaining source code
COPY package.json .
RUN bun install --minimum-release-age 259200 --frozen-lockfile --no-cache
COPY --exclude=node_modules --exclude=.env --exclude=*.log --exclude=*.lock . .

# Expose the port that the application listens on
ARG DEFAULT_PORT=80
ENV PORT=${DEFAULT_PORT}
EXPOSE ${DEFAULT_PORT}

# Run the application
CMD ["bun", "run", "start"]