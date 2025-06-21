const { execSync } = require('child_process');
let serverConfigs = {};

function getAppPort(config) {
  return (config.app && config.app.env && config.app.env.PORT) ? config.app.env.PORT : 3000;
}

function getFilteredServers(api) {
  const config = api.getConfig();
  const options = api.getOptions();
  const allServers = config.app.servers || {};
  if (options.servers) {
    const selectedServers = Array.isArray(options.servers) ? options.servers : options.servers.split(',');
    const filteredServers = {};
    selectedServers.forEach(serverName => {
      if (allServers[serverName]) {
        filteredServers[serverName] = allServers[serverName];
      }
    });
    return filteredServers;
  }
  return allServers;
}

function getInstanceCount(config, serverName) {
  const serverConfig = serverConfigs[serverName];
  const globalConfig = config.multiCore;
  return serverConfig?.instances || globalConfig?.instances || 'auto';
}

function getStartingPort(config, serverName) {
  const serverConfig = serverConfigs[serverName];
  const globalConfig = config.multiCore;
  return serverConfig?.startingPort || globalConfig?.startingPort || 3001;
}

function shouldUseNginx(config, serverName) {
  const serverConfig = serverConfigs[serverName];
  const globalConfig = config.multiCore;
  return serverConfig?.useNginx || globalConfig?.useNginx || false;
}

async function detectCores(api, serverName) {
  const config = api.getConfig();
  const server = config.servers[serverName];
  try {
    const result = await api.runSSHCommand(server, 'nproc');
    return parseInt(result.output.trim());
  } catch (error) {
    console.log(`⚠️ Could not detect cores on ${serverName}, defaulting to 2`);
    return 2;
  }
}

async function updateMupNginx(api) {
  const config = api.getConfig();
  const serversToProcess = getFilteredServers(api);
  const appName = config.app.name;
  const appPort = getAppPort(config);

  console.log('🔧 MUP Multi-Core Plugin: Updating nginx for load balancing...');

  return Promise.all(
    Object.keys(serversToProcess).map(async serverName => {
      if (!shouldUseNginx(config, serverName)) {
        console.log(`⏭️ ${serverName}: Skipping nginx update (backend worker)`);
        return;
      }
      const server = config.servers[serverName];
      const instanceCount = getInstanceCount(config, serverName);
      const startingPort = getStartingPort(config, serverName);
      const cores = instanceCount === 'auto' ? await detectCores(api, serverName) : instanceCount;
      try {
        let upstream = 'upstream meteor_backend {\n';
        upstream += `  server 127.0.0.1:${appPort};\n`;
        for (let i = 1; i < cores; i++) {
          upstream += `  server 127.0.0.1:${startingPort + i - 1};\n`;
        }
        upstream += '}\n';

        await api.runSSHCommand(server, `sudo cp /opt/${appName}/config/env.list /tmp/${appName}.env.backup`);
        await api.runSSHCommand(server, `cat > /tmp/${appName}-upstream.conf << 'EOF'\n${upstream}\nEOF`);
        await api.runSSHCommand(server, `
          if [ -f /etc/nginx/sites-enabled/default ]; then
            sudo sed -i 's/proxy_pass.*${appPort};/proxy_pass http:\\/\\/meteor_backend;/g' /etc/nginx/sites-enabled/default
          fi
        `);
        await api.runSSHCommand(server, `
          sudo sed -i '/http {/r /tmp/${appName}-upstream.conf' /etc/nginx/nginx.conf || true
        `);
        await api.runSSHCommand(server, `sudo nginx -t && sudo systemctl reload nginx || true`);
        console.log(`✅ ${serverName}: Updated nginx for ${cores} total containers (1 main + ${cores - 1} workers)`);
      } catch (error) {
        console.log(`❌ ${serverName}: Error updating nginx - ${error.message}`);
      }
    })
  );
}

async function startWorkerContainers(api) {
  const config = api.getConfig();
  const serversToProcess = getFilteredServers(api);
  const appName = config.app.name;
  const appPort = getAppPort(config);

  console.log('');
  console.log('🔧 MUP Multi-Core Plugin: Starting additional worker containers...');
  console.log('   (Main container already running via MUP)');

  return Promise.all(
    Object.keys(serversToProcess).map(async serverName => {
      const server = config.servers[serverName];
      const instanceCount = getInstanceCount(config, serverName);
      const startingPort = getStartingPort(config, serverName);
      const cores = instanceCount === 'auto' ? await detectCores(api, serverName) : instanceCount;

      if (cores <= 1) {
        console.log(`📦 ${serverName}: Single core detected, cleaning up any existing workers...`);
        try {
          const existingWorkers = await api.runSSHCommand(server, `docker ps -aq --filter name=${appName}-worker`);
          if (existingWorkers.output.trim()) {
            await api.runSSHCommand(server, `docker stop $(docker ps -aq --filter name=${appName}-worker) || true`);
            await api.runSSHCommand(server, `docker rm $(docker ps -aq --filter name=${appName}-worker) || true`);
            console.log(`   🧹 Cleaned up existing worker containers`);
          }
        } catch (error) {
          for (let i = 1; i <= 10; i++) {
            await api.runSSHCommand(server, `docker stop ${appName}-worker-${i} || true`);
            await api.runSSHCommand(server, `docker rm ${appName}-worker-${i} || true`);
          }
        }
        console.log(`✅ ${serverName}: No additional workers needed (main container only)`);
        return;
      }

      try {
        const imageQuery = await api.runSSHCommand(server, `docker inspect ${appName} --format='{{.Image}}'`);
        const actualImage = imageQuery.output.trim();
        if (!actualImage) {
          console.log(`❌ ${serverName}: Could not detect main container image`);
          return;
        }
        console.log(`🔍 ${serverName}: Using image: ${actualImage}`);
        try {
          const existingWorkers = await api.runSSHCommand(server, `docker ps -aq --filter name=${appName}-worker`);
          if (existingWorkers.output.trim()) {
            console.log(`   🧹 Cleaning up existing worker containers...`);
            await api.runSSHCommand(server, `docker stop $(docker ps -aq --filter name=${appName}-worker) || true`);
            await api.runSSHCommand(server, `docker rm $(docker ps -aq --filter name=${appName}-worker) || true`);
          }
        } catch (error) {
          for (let i = 1; i <= 10; i++) {
            await api.runSSHCommand(server, `docker stop ${appName}-worker-${i} || true`);
            await api.runSSHCommand(server, `docker rm ${appName}-worker-${i} || true`);
          }
        }
        console.log(`📦 ${serverName}: Starting ${cores - 1} additional worker container(s) (${cores} total cores)`);
        for (let i = 1; i < cores; i++) {
          const containerName = `${appName}-worker-${i}`;
          const port = startingPort + i - 1;
          const runCmd = `docker run -d \
            --name ${containerName} \
            --hostname ${serverName}-${appName}-${i} \
            --restart always \
            --network=bridge \
            -p 127.0.0.1:${port}:${appPort} \
            -e PORT=${appPort} \
            -e CORE_ID=${i} \
            --env-file /opt/${appName}/config/env.list \
            ${actualImage}`;
          try {
            const runResult = await api.runSSHCommand(server, runCmd);
            await new Promise(resolve => setTimeout(resolve, 2000));
            const statusCheck = await api.runSSHCommand(server, `docker ps --filter name=${containerName} --format "{{.Names}} {{.Status}}"`);
            if (statusCheck.output.includes(containerName) && statusCheck.output.includes('Up')) {
              console.log(`   ✅ Worker container: ${containerName} (port ${port}, core-${i})`);
            } else {
              const logs = await api.runSSHCommand(server, `docker logs ${containerName} 2>&1 || echo "Container not found"`);
              console.log(`   ❌ Worker container ${containerName} failed to start properly`);
              console.log(`   📋 Container logs: ${logs.output}`);
              const imageCheck = await api.runSSHCommand(server, `docker images ${actualImage} --format "{{.Repository}}:{{.Tag}}"`);
              if (!imageCheck.output.includes(actualImage)) {
                console.log(`   ⚠️  Image ${actualImage} not found. Make sure MUP has built the image.`);
              }
            }
          } catch (error) {
            console.log(`   ❌ Failed to start worker container ${containerName}: ${error.message}`);
          }
        }
        const status = await api.runSSHCommand(server, `docker ps | grep ${appName}`);
        console.log(`📊 ${serverName}: All containers running:`);
        status.output.split('\n').forEach(line => {
          if (line.trim()) {
            console.log(`   ${line}`);
          }
        });
      } catch (error) {
        console.log(`❌ ${serverName}: Error starting worker containers - ${error.message}`);
      }
    })
  );
}

async function stopWorkerContainers(api) {
  const config = api.getConfig();
  const serversToProcess = getFilteredServers(api);
  const appName = config.app.name;

  console.log('');
  console.log('🔧 MUP Multi-Core Plugin: Stopping worker containers...');
  console.log('   (Main container will remain running)');

  return Promise.all(
    Object.keys(serversToProcess).map(async serverName => {
      const server = config.servers[serverName];
      try {
        const workerList = await api.runSSHCommand(server, `docker ps -q --filter name=${appName}-worker`);
        if (workerList.output.trim()) {
          await api.runSSHCommand(server, `docker stop $(docker ps -q --filter name=${appName}-worker)`);
          await api.runSSHCommand(server, `docker rm $(docker ps -aq --filter name=${appName}-worker)`);
          console.log(`✅ ${serverName}: Stopped worker containers (main container still running)`);
        } else {
          console.log(`📦 ${serverName}: No worker containers found to stop`);
        }
      } catch (error) {
        console.log(`❌ ${serverName}: Error stopping worker containers - ${error.message}`);
      }
    })
  );
}

async function restartWorkerContainers(api) {
  const config = api.getConfig();
  const serversToProcess = getFilteredServers(api);
  const appName = config.app.name;

  console.log('');
  console.log('🔧 MUP Multi-Core Plugin: Restarting worker containers...');
  console.log('   (Main container managed separately by MUP)');

  return Promise.all(
    Object.keys(serversToProcess).map(async serverName => {
      const server = config.servers[serverName];
      try {
        const workerList = await api.runSSHCommand(server, `docker ps -aq --filter name=${appName}-worker`);
        if (workerList.output.trim()) {
          await api.runSSHCommand(server, `docker restart $(docker ps -aq --filter name=${appName}-worker)`);
          console.log(`✅ ${serverName}: Restarted worker containers`);
        } else {
          console.log(`📦 ${serverName}: No worker containers found, starting new ones...`);
          return startWorkerContainers(api);
        }
      } catch (error) {
        console.log(`❌ ${serverName}: Error restarting worker containers - ${error.message}`);
      }
    })
  );
}

async function aggregateLogs(api) {
  const config = api.getConfig();
  const serversToProcess = getFilteredServers(api);
  const appName = config.app.name;

  return Promise.all(
    Object.keys(serversToProcess).map(async serverName => {
      const server = config.servers[serverName];
      try {
        console.log(`📋 Logs from ${serverName}:`);
        const mainLogs = await api.runSSHCommand(server, `docker logs --tail=50 ${appName} 2>&1 || true`);
        if (mainLogs.output) {
          console.log(`\n=== ${appName} (main) ===`);
          console.log(mainLogs.output);
        }
        const workers = await api.runSSHCommand(server, `docker ps --filter name=${appName}-worker --format "{{.Names}}" || true`);
        if (workers.output.trim()) {
          const workerNames = workers.output.trim().split('\n');
          for (const workerName of workerNames) {
            const workerLogs = await api.runSSHCommand(server, `docker logs --tail=20 ${workerName} 2>&1 || true`);
            if (workerLogs.output) {
              console.log(`\n=== ${workerName} ===`);
              console.log(workerLogs.output);
            }
          }
        }
      } catch (error) {
        console.log(`❌ Error getting logs from ${serverName}:`, error.message);
      }
    })
  );
}

module.exports = {
  name: 'mup-multicore',
  description: 'Multi-container deployment for CPU core utilization (MUP compatible)',

  validate: {
    'multiCore'(config, utils) {
      const details = [];
      if (!config.multiCore) return details;
      const multiCore = config.multiCore;
      if (multiCore.instances !== undefined) {
        if (typeof multiCore.instances !== 'string' && typeof multiCore.instances !== 'number') {
          details.push({ message: 'instances must be \"auto\" or a number', path: 'multiCore.instances' });
        } else if (typeof multiCore.instances === 'string' && multiCore.instances !== 'auto') {
          details.push({ message: 'instances string value must be \"auto\"', path: 'multiCore.instances' });
        } else if (typeof multiCore.instances === 'number' && multiCore.instances < 1) {
          details.push({ message: 'instances must be at least 1', path: 'multiCore.instances' });
        }
      }
      if (multiCore.startingPort !== undefined) {
        if (typeof multiCore.startingPort !== 'number') {
          details.push({ message: 'startingPort must be a number', path: 'multiCore.startingPort' });
        } else if (multiCore.startingPort < 1024 || multiCore.startingPort > 65535) {
          details.push({ message: 'startingPort must be between 1024 and 65535', path: 'multiCore.startingPort' });
        }
      }
      if (multiCore.useNginx !== undefined) {
        if (typeof multiCore.useNginx !== 'boolean') {
          details.push({ message: 'useNginx must be a boolean', path: 'multiCore.useNginx' });
        }
      }
      return details;
    },
    'app.servers'(config, utils) {
      const details = [];
      if (!config.app || !config.app.servers) return details;
      Object.keys(config.app.servers).forEach(serverName => {
        const serverConfig = config.app.servers[serverName];
        if (serverConfig && serverConfig.multiCore) {
          const multiCore = serverConfig.multiCore;
          const basePath = `app.servers.${serverName}.multiCore`;
          if (typeof multiCore !== 'object') {
            details.push({ message: 'multiCore configuration must be an object', path: basePath });
            return;
          }
          if (multiCore.instances !== undefined) {
            if (typeof multiCore.instances !== 'string' && typeof multiCore.instances !== 'number') {
              details.push({ message: 'instances must be \"auto\" or a number', path: `${basePath}.instances` });
            } else if (typeof multiCore.instances === 'string' && multiCore.instances !== 'auto') {
              details.push({ message: 'instances string value must be \"auto\"', path: `${basePath}.instances` });
            } else if (typeof multiCore.instances === 'number' && multiCore.instances < 1) {
              details.push({ message: 'instances must be at least 1', path: `${basePath}.instances` });
            }
          }
          if (multiCore.startingPort !== undefined) {
            if (typeof multiCore.startingPort !== 'number') {
              details.push({ message: 'startingPort must be a number', path: `${basePath}.startingPort` });
            } else if (multiCore.startingPort < 1024 || multiCore.startingPort > 65535) {
              details.push({ message: 'startingPort must be between 1024 and 65535', path: `${basePath}.startingPort` });
            }
          }
          if (multiCore.useNginx !== undefined) {
            if (typeof multiCore.useNginx !== 'boolean') {
              details.push({ message: 'useNginx must be a boolean', path: `${basePath}.useNginx` });
            }
          }
        }
      });
      return details;
    }
  },

  commands: {
    logs: {
      description: 'Show logs from all containers',
      handler: aggregateLogs
    }
  },

  hooks: {
    'post.default.deploy'(api) {
      const config = api.getConfig();
      if (config.app && config.app.docker) {
        const serversToProcess = getFilteredServers(api);
        const needsNginx = Object.keys(serversToProcess).some(serverName => shouldUseNginx(config, serverName));
        if (needsNginx) {
          return startWorkerContainers(api).then(() => updateMupNginx(api));
        } else {
          return startWorkerContainers(api);
        }
      }
    },
    'post.default.start'(api) {
      const config = api.getConfig();
      if (config.app && config.app.docker) {
        return startWorkerContainers(api);
      }
    },
    'post.default.restart'(api) {
      const config = api.getConfig();
      if (config.app && config.app.docker) {
        return restartWorkerContainers(api);
      }
    },
    'post.default.stop'(api) {
      const config = api.getConfig();
      if (config.app && config.app.docker) {
        return stopWorkerContainers(api);
      }
    }
  },

  prepareConfig(config) {
    if (config.app && config.app.servers) {
      serverConfigs = {};
      Object.keys(config.app.servers).forEach(serverName => {
        const serverConfig = config.app.servers[serverName];
        if (serverConfig && serverConfig.multiCore) {
          serverConfigs[serverName] = serverConfig.multiCore;
          delete serverConfig.multiCore;
        }
      });
    }
    return config;
  }
};
