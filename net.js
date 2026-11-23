'use strict';

// =====================================================================
//  Кімната: зашифровані повідомлення через публічні MQTT-брокери.
//  Брокер лише пересилає байти; без пароля їх не розшифрувати.
// =====================================================================
const MQTT_LIB = 'https://unpkg.com/mqtt@5.10.1/dist/mqtt.min.js';
const BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt'
];
const CONNECT_TIMEOUT_MS = 8000;

function loadScript(src) {
  if (window.mqtt) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Не вдалося завантажити бібліотеку MQTT. Перевірте інтернет.'));
    document.head.append(script);
  });
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomId() {
  return toHex(crypto.getRandomValues(new Uint8Array(8)));
}

// Клавіатури телефонів додають пробіли й великі літери: прибираємо їх,
// інакше гравці потрапляють у різні кімнати
async function deriveRoom(room, password) {
  const normalizedRoom = room.trim().toLowerCase().replace(/\s+/g, ' ');
  const normalizedPassword = password.trim();
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode('poyasny|' + normalizedRoom + '|' + normalizedPassword));
  const hex = toHex(digest);
  const baseKey = await crypto.subtle.importKey('raw', encoder.encode(normalizedPassword), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: encoder.encode('poyasny|' + normalizedRoom), iterations: 100000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']);
  return { topic: 'poyasny-v1/' + hex.slice(0, 32), code: hex.slice(0, 4).toUpperCase(), key };
}

async function encrypt(key, message) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(message));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const packet = new Uint8Array(iv.length + cipher.length);
  packet.set(iv);
  packet.set(cipher, iv.length);
  return packet;
}

async function decrypt(key, packet) {
  const bytes = new Uint8Array(packet);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(plain));
}

function connectBroker(url) {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(url, {
      clientId: 'poyasny-' + randomId(),
      clean: true,
      connectTimeout: CONNECT_TIMEOUT_MS,
      reconnectPeriod: 2000
    });
    const timer = setTimeout(() => {
      client.end(true);
      reject(new Error('timeout: ' + url));
    }, CONNECT_TIMEOUT_MS + 1000);
    client.once('connect', () => {
      clearTimeout(timer);
      resolve(client);
    });
  });
}

class Room {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.clients = [];
    this.seen = new Set();
    this.seenOrder = [];
    this.topic = null;
    this.key = null;
    this.code = null;
  }

  async join(room, password) {
    await loadScript(MQTT_LIB);
    Object.assign(this, await deriveRoom(room, password));

    // Підключаємося до всіх брокерів одразу. Заходимо, щойно відповів перший,
    // повільніші приєднуються, коли встигнуть.
    const attempts = BROKERS.map(url => connectBroker(url).then(client => this.attach(client)));
    try {
      await Promise.any(attempts);
    } catch {
      throw new Error('Не вдалося підключитися до жодного сервера повідомлень. Спробуйте іншу мережу.');
    }
  }

  attach(client) {
    this.clients.push(client);
    client.on('message', (topic, payload, packet) => this.receive(topic, payload, Boolean(packet && packet.retain)));
    client.subscribe(this.topic + '/#');
  }

  // retained = збережене брокером повідомлення, а не щойно надіслане
  async receive(topic, payload, retained) {
    let message;
    try {
      message = await decrypt(this.key, payload);
    } catch {
      return;
    }
    // Те саме повідомлення приходить з кожного брокера: обробляємо один раз
    if (!message.mid || this.seen.has(message.mid)) {
      return;
    }
    this.seen.add(message.mid);
    this.seenOrder.push(message.mid);
    if (this.seenOrder.length > 1000) {
      this.seen.delete(this.seenOrder.shift());
    }
    this.onMessage(topic.slice(this.topic.length + 1), message, retained);
  }

  async send(channel, message, retain) {
    const packet = await encrypt(this.key, Object.assign({ mid: randomId() }, message));
    for (const client of this.clients) {
      client.publish(this.topic + '/' + channel, packet, { qos: 0, retain: Boolean(retain) });
    }
  }

  leave() {
    for (const client of this.clients) {
      client.end(true);
    }
    this.clients = [];
  }
}
