FROM oven/bun:1.3.3 as builder

WORKDIR /app

COPY package.json bun.lockb* ./
# Use --frozen-lockfile to ensure reproducible builds
RUN bun install --frozen-lockfile

# Copy the rest of the source code
COPY . .

# Run the build command defined in package.json (e.g., "vite build")
RUN bun run build

# ----------------------------------------------------------------------
# 2. Production Stage
# Use a minimal Nginx image to serve the compiled static files securely and efficiently
# ----------------------------------------------------------------------
FROM nginx:alpine

# Copy the built application files from the builder stage into the Nginx public directory
COPY --from=builder /app/dist /usr/share/nginx/html

# Nginx listens on port 80 by default
EXPOSE 80

# Configure Nginx to handle single-page application routing (optional, but recommended)
# This prevents 404 errors when users hit a route directly, ensuring all non-file
# requests fall back to index.html.
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Command to start Nginx
CMD ["nginx", "-g", "daemon off;"]
