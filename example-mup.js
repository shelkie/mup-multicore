module.exports = {
  // Add the multi-core plugin
  plugins: ['mup-multicore'],

  // Multi-core configuration (global defaults)
  multiCore: {
    instances: 'auto',     // Auto-detect CPU cores, or specify a number
    startingPort: 3001,    // Starting port for worker containers (optional)
    useNginx: false        // Enable nginx load balancing (optional)
  },

  servers: {
    web1: {
      host: '1.2.3.4',
      username: 'root',
      pem: '~/.ssh/id_rsa'
    },
    worker1: {
      host: '5.6.7.8', 
      username: 'root',
      pem: '~/.ssh/id_rsa'
    }
  },

  app: {
    name: 'myapp',
    path: '../',
    type: 'meteor',

    servers: {
      // Override global settings per server
      web1: {
        // Web server needs nginx load balancing
        multiCore: { 
          useNginx: true 
        }
      },
      // Backend worker uses global defaults (no nginx)
      worker1: {}
    },

    buildOptions: {
      serverOnly: true
    },

    env: {
      ROOT_URL: 'https://myapp.com',
      MONGO_URL: 'mongodb://localhost/myapp',
      PORT: 3000,
      CORE_ID: 0  // Required for main container identification
    },

    docker: {
      image: 'zodern/meteor'
    }
  },

  // Optional: Centralized logging configuration
  // (keeps your existing logging setup)
  
  // Optional: Proxy configuration  
  // (keeps your existing proxy setup)
};

/*
After deployment with this plugin, each server will run:
- Multiple Docker containers (one per CPU core)
- Instead of single container
- Automatic load balancing via nginx (if enabled)
- Better CPU utilization and performance

To verify containers are running after deployment:
1. SSH into your server: mup ssh
2. Check container status: docker ps
3. You should see multiple containers running (myapp, myapp-worker-1, etc.)
*/ 