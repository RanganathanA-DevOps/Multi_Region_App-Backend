# Build Stage
FROM node:18-alpine AS build

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

# RUN npm run build && rm -rf /var/lib/apt/lists/*

# COPY .env ./build
 
# Production Stage
FROM node:18-alpine AS production

# Set working directory
WORKDIR /app

# Install PM2, system dependencies, and create a non-root user
RUN npm install -g pm2 && \
    apk add --no-cache shadow && \
    useradd -m nodeuser && chown -R nodeuser:nodeuser /app

# Install FFmpeg globally
RUN apk add --no-cache ffmpeg

# Copy the application files from the build stage
COPY --from=build /app /app

# Expose the port your app will run on
EXPOSE 80

# Use exec form for CMD
# CMD ["pm2", "start", "/app/build/server.js", "--no-daemon"]
CMD [ "npm", "start" ]