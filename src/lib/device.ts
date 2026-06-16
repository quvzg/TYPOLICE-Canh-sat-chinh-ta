"use client";

const DEVICE_STORAGE_KEY = "typolice_device_id";
const DEVICE_COOKIE = "typolice_device_id";
const DEVICE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 5;

function createDeviceId() {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return `device_${random.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export function getTypoliceDeviceId() {
  if (typeof window === "undefined") return "shared";
  let id = window.localStorage.getItem(DEVICE_STORAGE_KEY);
  if (!id || !/^device_[a-zA-Z0-9_-]+$/.test(id)) {
    id = createDeviceId();
    window.localStorage.setItem(DEVICE_STORAGE_KEY, id);
  }
  document.cookie = `${DEVICE_COOKIE}=${encodeURIComponent(id)}; Path=/; Max-Age=${DEVICE_MAX_AGE_SECONDS}; SameSite=Lax`;
  return id;
}

export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("X-Typolice-Device-Id", getTypoliceDeviceId());
  return fetch(input, { ...init, headers });
}
