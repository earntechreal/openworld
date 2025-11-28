import * as THREE from './libs/three.module.js';
import { mergeBufferGeometries } from './libs/BufferGeometryUtils.js';

// ==========================================
// 1. CONFIGURATION & STATE
// ==========================================
const CHUNK_SIZE = 16;
const CHUNK_HEIGHT = 24;
const RENDER_DISTANCE = 2; // Radius
const GRAVITY = 25.0;
const JUMP_FORCE = 8.0;
const SPEED = 6.0;

const BLOCK = {
    AIR: 0,
    GRASS: 1,
    DIRT: 2,
    STONE: 3,
    SAND: 4,
    WOOD: 5,
    BRICK: 6
};

// Texture offsets in our generated atlas (Row, Col)
const TEXTURE_MAP = {
    [BLOCK.GRASS]: { top: [0,0], side: [0,1], bottom: [0,2] },
    [BLOCK.DIRT]:  { all: [0,2] },
    [BLOCK.STONE]: { all: [1,0] },
    [BLOCK.SAND]:  { all: [1,1] },
    [BLOCK.WOOD]:  { side: [1,2], top: [1,3], bottom: [1,3] },
    [BLOCK.BRICK]: { all: [2,0] }
};

let scene, camera, renderer;
let chunks = {}; // key: "x,z", value: { mesh, data: Uint8Array }
let textureAtlas;
let player = {
    velocity: new THREE.Vector3(),
    onGround: false,
    height: 1.6,
    radius: 0.3
};
let selectedBlock = BLOCK.GRASS;

// Inputs
let moveInput = { x: 0, y: 0 };
let lastTouchPos = { x: 0, y: 0 };
let breakTimer = null;
let isTouchingLook = false;
let touchStartTime = 0;
let touchStartCoords = {x:0, y:0};

// Raycasting
const raycaster = new THREE.Raycaster();
raycaster.far = 6; // Reach distance

init();
animate();

// ==========================================
// 2. INITIALIZATION
// ==========================================
function init() {
    // Scene Setup
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87CEEB);
    scene.fog = new THREE.Fog(0x87CEEB, 20, 50);

    // Camera
    camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(CHUNK_SIZE / 2, CHUNK_HEIGHT + 5, CHUNK_SIZE / 2);

    // Lights
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
    scene.add(hemiLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(50, 100, 50);
    scene.add(dirLight);

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: false }); // False for performance
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    // Generate Textures
    textureAtlas = createTextureAtlas();

    // Initial World Gen
    updateChunks();

    // Event Listeners
    window.addEventListener('resize', onWindowResize, false);
    setupUI();
    setupTouchControls();

    alert("Game Loaded OK! Left side: Move. Right side: Look. Tap right to Place. Long press right to Break.");
}

// ==========================================
// 3. TEXTURE GENERATION (Procedural)
// ==========================================
function createTextureAtlas() {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const size = 64; // size of one tile
    const cols = 4;
    const rows = 4;
    canvas.width = size * cols;
    canvas.height = size * rows;

    // Helper to fill rect
    function drawTile(c, r, color, noise = false) {
        ctx.fillStyle = color;
        ctx.fillRect(c * size, r * size, size, size);
        if (noise) {
            for(let i=0; i<50; i++) {
                ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.2})`;
                ctx.fillRect(c*size + Math.random()*size, r*size + Math.random()*size, 2, 2);
            }
        }
        ctx.strokeStyle = "rgba(0,0,0,0.1)";
        ctx.strokeRect(c*size, r*size, size, size);
    }

    // 0,0: Grass Top
    drawTile(0, 0, '#4CBB17', true); 
    // 0,1: Grass Side
    drawTile(1, 0, '#6FA336', true);
    ctx.fillStyle = '#5D4037'; ctx.fillRect(64, 50, 64, 14); // dirt bottom
    // 0,2: Dirt
    drawTile(2, 0, '#5D4037', true);
    // 1,0: Stone
    drawTile(0, 1, '#9E9E9E', true);
    // 1,1: Sand
    drawTile(1, 1, '#FDD835', true);
    // 1,2: Wood Side
    drawTile(2, 1, '#795548', false);
    ctx.fillStyle = '#5D4037'; 
    ctx.fillRect(128 + 10, 64, 10, 64); ctx.fillRect(128 + 40, 64, 10, 64);
    // 1,3: Wood Top
    drawTile(3, 1, '#8D6E63', true);
    // 2,0: Brick
    drawTile(0, 2, '#D32F2F', false);
    
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    return tex;
}

// ==========================================
// 4. WORLD GENERATION & MESHING
// ==========================================
function getChunkKey(cx, cz) {
    return `${cx},${cz}`;
}

function updateChunks() {
    // Simple render distance logic
    const playerChunkX = Math.floor(camera.position.x / CHUNK_SIZE);
    const playerChunkZ = Math.floor(camera.position.z / CHUNK_SIZE);

    for (let x = -RENDER_DISTANCE; x <= RENDER_DISTANCE; x++) {
        for (let z = -RENDER_DISTANCE; z <= RENDER_DISTANCE; z++) {
            const cx = playerChunkX + x;
            const cz = playerChunkZ + z;
            const key = getChunkKey(cx, cz);

            if (!chunks[key]) {
                const data = generateChunkData(cx, cz);
                chunks[key] = {
                    data: data,
                    mesh: null
                };
                buildChunkMesh(cx, cz, data);
            }
        }
    }
}

function generateChunkData(cx, cz) {
    const data = new Uint8Array(CHUNK_SIZE * CHUNK_HEIGHT * CHUNK_SIZE);
    for (let x = 0; x < CHUNK_SIZE; x++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
            // Simple wavy terrain
            const worldX = cx * CHUNK_SIZE + x;
            const worldZ = cz * CHUNK_SIZE + z;
            // Basic "noise" replacement
            const height = Math.floor(5 + Math.sin(worldX * 0.1) * 2 + Math.cos(worldZ * 0.1) * 2);
            
            for (let y = 0; y < CHUNK_HEIGHT; y++) {
                const index = (y * CHUNK_SIZE * CHUNK_SIZE) + (z * CHUNK_SIZE) + x;
                if (y < height) {
                    data[index] = y < height - 3 ? BLOCK.STONE : BLOCK.DIRT;
                } else if (y === height) {
                    data[index] = BLOCK.GRASS;
                } else {
                    data[index] = BLOCK.AIR;
                }
            }
        }
    }
    return data;
}

function getBlock(cx, cz, x, y, z) {
    const key = getChunkKey(cx, cz);
    if (!chunks[key]) return BLOCK.AIR;
    if (x < 0 || x >= CHUNK_SIZE || z < 0 || z >= CHUNK_SIZE || y < 0 || y >= CHUNK_HEIGHT) {
        // Simple neighbor checking could go here, returning 0 for now (open edges)
        return BLOCK.AIR;
    }
    const index = (y * CHUNK_SIZE * CHUNK_SIZE) + (z * CHUNK_SIZE) + x;
    return chunks[key].data[index];
}

function setBlock(wx, wy, wz, id) {
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cz = Math.floor(wz / CHUNK_SIZE);
    const lx = Math.floor(wx - cx * CHUNK_SIZE);
    const lz = Math.floor(wz - cz * CHUNK_SIZE);
    const ly = Math.floor(wy);

    const key = getChunkKey(cx, cz);
    if (chunks[key] && ly >= 0 && ly < CHUNK_HEIGHT) {
        const index = (ly * CHUNK_SIZE * CHUNK_SIZE) + (lz * CHUNK_SIZE) + lx;
        chunks[key].data[index] = id;
        
        // Rebuild mesh
        if (chunks[key].mesh) {
            scene.remove(chunks[key].mesh);
            chunks[key].mesh.geometry.dispose();
        }
        buildChunkMesh(cx, cz, chunks[key].data);
    }
}

function buildChunkMesh(cx, cz, data) {
    const geometries = [];
    const matrix = new THREE.Matrix4();
    const px = new THREE.Vector3();

    // UV helper vars
    const tileRes = 0.25; // 1 / 4 columns

    for (let y = 0; y < CHUNK_HEIGHT; y++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
            for (let x = 0; x < CHUNK_SIZE; x++) {
                const index = (y * CHUNK_SIZE * CHUNK_SIZE) + (z * CHUNK_SIZE) + x;
                const type = data[index];

                if (type === BLOCK.AIR) continue;

                const worldPos = { x: cx * CHUNK_SIZE + x, y: y, z: cz * CHUNK_SIZE + z };
                
                // Check neighbors to cull faces
                // Right (x+1)
                if (getBlock(cx, cz, x + 1, y, z) === BLOCK.AIR) {
                    addFace(1, 0, 0, 0, Math.PI / 2, worldPos, type, 'side');
                }
                // Left (x-1)
                if (getBlock(cx, cz, x - 1, y, z) === BLOCK.AIR) {
                    addFace(-1, 0, 0, 0, -Math.PI / 2, worldPos, type, 'side');
                }
                // Top (y+1)
                if (getBlock(cx, cz, x, y + 1, z) === BLOCK.AIR) {
                    addFace(0, 1, 0, -Math.PI / 2, 0, worldPos, type, 'top');
                }
                // Bottom (y-1)
                if (getBlock(cx, cz, x, y - 1, z) === BLOCK.AIR) {
                    addFace(0, -1, 0, Math.PI / 2, 0, worldPos, type, 'bottom');
                }
                // Front (z+1)
                if (getBlock(cx, cz, x, y, z + 1) === BLOCK.AIR) {
                    addFace(0, 0, 1, 0, 0, worldPos, type, 'side');
                }
                // Back (z-1)
                if (getBlock(cx, cz, x, y, z - 1) === BLOCK.AIR) {
                    addFace(0, 0, -1, 0, Math.PI, worldPos, type, 'side');
                }
            }
        }
    }

    function addFace(ox, oy, oz, rx, ry, pos, type, faceName) {
        const geometry = new THREE.PlaneGeometry(1, 1);
        
        // UV Mapping
        const def = TEXTURE_MAP[type];
        let uvCoords = def.all || def[faceName] || [0,0];
        const col = uvCoords[0];
        const row = uvCoords[1];
        
        // Remap UVs
        const uvs = geometry.attributes.uv;
        for (let i = 0; i < uvs.count; i++) {
            uvs.setX(i, (uvs.getX(i) + col) * tileRes);
            uvs.setY(i, 1 - ((1 - uvs.getY(i) + row) * tileRes));
        }

        matrix.makeRotationFromEuler(new THREE.Euler(rx, ry, 0));
        matrix.setPosition(pos.x + ox * 0.5, pos.y + oy * 0.5, pos.z + oz * 0.5);
        geometry.applyMatrix4(matrix);
        geometries.push(geometry);
    }

    if (geometries.length === 0) return;

    const mergedGeometry = mergeBufferGeometries(geometries);
    const material = new THREE.MeshLambertMaterial({ map: textureAtlas, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(mergedGeometry, material);
    
    chunks[getChunkKey(cx, cz)].mesh = mesh;
    scene.add(mesh);
}

// ==========================================
// 5. INPUTS & INTERACTION
// ==========================================
function setupUI() {
    // Inventory
    document.querySelectorAll('.block-select').forEach(el => {
        el.addEventListener('click', (e) => {
            selectedBlock = parseInt(el.dataset.id);
            document.querySelectorAll('.block-select').forEach(b => b.classList.remove('active'));
            el.classList.add('active');
        });
    });
    
    document.getElementById('btn-inv').addEventListener('click', () => {
        const p = document.getElementById('inventory-panel');
        p.style.display = p.style.display === 'none' ? 'flex' : 'none';
    });

    // Jump
    document.getElementById('btn-jump').addEventListener('touchstart', (e) => {
        e.preventDefault();
        if (player.onGround) player.velocity.y = JUMP_FORCE;
    });

    // Save/Load
    document.getElementById('btn-save').addEventListener('click', saveWorld);
    document.getElementById('btn-load').addEventListener('click', loadWorld);
}

function setupTouchControls() {
    const moveZone = document.getElementById('zone-move');
    const lookZone = document.getElementById('zone-look');

    // Move Logic
    moveZone.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const touch = e.changedTouches[0];
        lastTouchPos.move = { x: touch.clientX, y: touch.clientY };
        moveInput.origin = { x: touch.clientX, y: touch.clientY };
    }, {passive: false});

    moveZone.addEventListener('touchmove', (e) => {
        e.preventDefault();
        const touch = e.changedTouches[0];
        // Calculate stick magnitude
        const dx = touch.clientX - moveInput.origin.x;
        const dy = touch.clientY - moveInput.origin.y;
        
        // Normalize 
        moveInput.x = Math.max(-1, Math.min(1, dx / 50));
        moveInput.y = Math.max(-1, Math.min(1, dy / 50));
    }, {passive: false});

    moveZone.addEventListener('touchend', (e) => {
        e.preventDefault();
        moveInput.x = 0;
        moveInput.y = 0;
    });

    // Look + Action Logic
    lookZone.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const touch = e.changedTouches[0];
        lastTouchPos.look = { x: touch.clientX, y: touch.clientY };
        touchStartCoords = { x: touch.clientX, y: touch.clientY };
        isTouchingLook = true;
        touchStartTime = Date.now();

        // Start Break Timer
        breakTimer = setTimeout(() => {
            if (isTouchingLook) {
                // Check if moved significantly
                const dist = Math.hypot(
                    lastTouchPos.look.x - touchStartCoords.x,
                    lastTouchPos.look.y - touchStartCoords.y
                );
                if (dist < 10) doRaycastAction('break');
            }
        }, 500); // 500ms long press
    }, {passive: false});

    lookZone.addEventListener('touchmove', (e) => {
        e.preventDefault();
        const touch = e.changedTouches[0];
        if (!lastTouchPos.look) return;

        const dx = touch.clientX - lastTouchPos.look.x;
        const dy = touch.clientY - lastTouchPos.look.y;

        // Rotate Camera
        camera.rotation.y -= dx * 0.005;
        camera.rotation.x -= dy * 0.005;
        camera.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, camera.rotation.x));

        lastTouchPos.look = { x: touch.clientX, y: touch.clientY };
    }, {passive: false});

    lookZone.addEventListener('touchend', (e) => {
        e.preventDefault();
        clearTimeout(breakTimer);
        isTouchingLook = false;

        const duration = Date.now() - touchStartTime;
        const dist = Math.hypot(
            lastTouchPos.look.x - touchStartCoords.x,
            lastTouchPos.look.y - touchStartCoords.y
        );

        // If short tap and didn't move much -> PLACE BLOCK
        if (duration < 300 && dist < 10) {
            doRaycastAction('place');
        }
    });
}

function doRaycastAction(action) {
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const intersects = raycaster.intersectObjects(Object.values(chunks).map(c => c.mesh).filter(m => m));

    if (intersects.length > 0) {
        const hit = intersects[0];
        const p = hit.point;
        const n = hit.face.normal;

        // Determine target block coord
        // For breaking: move slightly inside the block
        // For placing: move slightly outside
        const tx = p.x + (action === 'break' ? -n.x : n.x) * 0.1;
        const ty = p.y + (action === 'break' ? -n.y : n.y) * 0.1;
        const tz = p.z + (action === 'break' ? -n.z : n.z) * 0.1;

        if (action === 'break') {
            setBlock(tx, ty, tz, BLOCK.AIR);
        } else {
            // Collision check: don't place inside player
            const bx = Math.floor(tx);
            const by = Math.floor(ty);
            const bz = Math.floor(tz);
            
            const px = Math.floor(camera.position.x);
            const py = Math.floor(camera.position.y - 1.5); // feet
            const pHead = Math.floor(camera.position.y);

            if (bx === px && bz === Math.floor(camera.position.z) && (by === py || by === pHead)) {
                return; // Inside player
            }

            setBlock(tx, ty, tz, selectedBlock);
        }
    }
}

// ==========================================
// 6. PHYSICS & LOOP
// ==========================================
function resolveCollision(newPos) {
    // Simple Point Collision for feet and head
    // Convert float to int
    const cx = Math.floor(newPos.x);
    const cz = Math.floor(newPos.z);
    
    // Check feet
    const feetY = Math.floor(newPos.y - 1.5);
    // Check head
    const headY = Math.floor(newPos.y);

    function isSolid(x, y, z) {
        // Calculate chunk
        const chX = Math.floor(x/CHUNK_SIZE);
        const chZ = Math.floor(z/CHUNK_SIZE);
        const localX = x - chX*CHUNK_SIZE;
        const localZ = z - chZ*CHUNK_SIZE;
        return getBlock(chX, chZ, localX, y, localZ) !== BLOCK.AIR;
    }

    if (isSolid(cx, feetY, cz) || isSolid(cx, headY, cz)) {
        return true; 
    }
    return false;
}

// Simple gravity/floor check without complex AABB
function updatePhysics(dt) {
    // Apply Gravity
    player.velocity.y -= GRAVITY * dt;

    // Movement Vector relative to camera Look
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    forward.y = 0; forward.normalize();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    right.y = 0; right.normalize();

    const moveVec = new THREE.Vector3();
    moveVec.addScaledVector(forward, -moveInput.y * SPEED * dt);
    moveVec.addScaledVector(right, moveInput.x * SPEED * dt);

    camera.position.add(moveVec);
    camera.position.y += player.velocity.y * dt;

    // Floor Collision (Very basic)
    const px = camera.position.x;
    const py = camera.position.y;
    const pz = camera.position.z;

    // Check block below feet
    const chX = Math.floor(px / CHUNK_SIZE);
    const chZ = Math.floor(pz / CHUNK_SIZE);
    const lx = Math.floor(px - chX * CHUNK_SIZE);
    const lz = Math.floor(pz - chZ * CHUNK_SIZE);
    const ly = Math.floor(py - 1.6); // Eyes to feet

    const blockBelow = getBlock(chX, chZ, lx, ly, lz);

    if (blockBelow !== BLOCK.AIR) {
        // Hit ground
        camera.position.y = ly + 1 + 1.6;
        player.velocity.y = 0;
        player.onGround = true;
    } else {
        player.onGround = false;
    }
    
    // Kill plane
    if (camera.position.y < -10) {
        camera.position.set(0, 30, 0);
        player.velocity.set(0,0,0);
    }
}

function animate() {
    requestAnimationFrame(animate);
    const dt = 0.016; // fixed step approximation
    updatePhysics(dt);
    updateChunks(); // Stream chunks
    renderer.render(scene, camera);
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// ==========================================
// 7. SAVE / LOAD SYSTEM
// ==========================================
function saveWorld() {
    const saveData = {};
    for (let key in chunks) {
        // Convert Uint8Array to Array for JSON storage (inefficient but works for small worlds)
        saveData[key] = Array.from(chunks[key].data);
    }
    localStorage.setItem('openWorldSave', JSON.stringify(saveData));
    alert('World Saved!');
}

function loadWorld() {
    const json = localStorage.getItem('openWorldSave');
    if (!json) {
        alert("No save found.");
        return;
    }
    const saveData = JSON.parse(json);
    
    // Clear current chunks
    for (let key in chunks) {
        if(chunks[key].mesh) {
            scene.remove(chunks[key].mesh);
            chunks[key].mesh.geometry.dispose();
        }
    }
    chunks = {};

    // Rebuild
    for (let key in saveData) {
        const [cx, cz] = key.split(',').map(Number);
        const data = new Uint8Array(saveData[key]);
        chunks[key] = { data: data, mesh: null };
        buildChunkMesh(cx, cz, data);
    }
    alert("World Loaded!");
}

