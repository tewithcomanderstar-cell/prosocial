"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useI18n } from "@/components/language-provider";

type DriveFolder = {
  id: string;
  name: string;
};

type DriveImage = {
  id: string;
  name: string;
  webContentLink?: string;
  thumbnailLink?: string;
  webViewLink?: string;
};

type GoogleDriveStatusDebug = {
  hasGoogleAccount: boolean;
  hasRefreshToken: boolean;
  credentialStatus: string;
  tokenExpiresAt: string | null;
  canRefreshToken: boolean;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
};

function mapGoogleDriveMessage(code: string, isThai: boolean) {
  const messages: Record<string, string> = {
    missing_code: isThai ? "Google ไม่ส่ง code กลับมา กรุณาลองเชื่อมต่อใหม่" : "Google did not return an authorization code.",
    invalid_state: isThai
      ? "รอบการเชื่อม Google Drive หมดอายุหรือ state ไม่ตรงกัน กรุณากดเชื่อมใหม่อีกครั้ง"
      : "The Google Drive OAuth state was invalid or expired. Please start the connection again.",
    oauth_failed: isThai ? "เชื่อมต่อ Google Drive ไม่สำเร็จ กรุณาลองใหม่" : "Google Drive connection failed. Please try again.",
    reconnect_required: isThai
      ? "Google Drive ต้องเชื่อมใหม่อีกครั้งเพื่อรีเฟรชสิทธิ์การเข้าถึง"
      : "Google Drive needs to be reconnected to refresh access.",
    google_reconnect_required: isThai
      ? "Google Drive ต้องเชื่อมใหม่อีกครั้งเพื่อรีเฟรชสิทธิ์การเข้าถึง"
      : "Google Drive needs to be reconnected to refresh access.",
    provider_not_connected: isThai
      ? "ยังไม่ได้เชื่อม Google Drive กับระบบนี้"
      : "Google Drive is not connected to this workspace yet.",
    google_provider_not_connected: isThai
      ? "ยังไม่ได้เชื่อม Google Drive กับระบบนี้"
      : "Google Drive is not connected to this workspace yet.",
    google_refresh_token_missing: isThai
      ? "Google ไม่ส่ง refresh token กลับมา และระบบไม่มี token เดิมให้ใช้ กรุณากดเชื่อม Google Drive ใหม่อีกครั้ง"
      : "Google did not return a refresh token and no previous refresh token is available. Please reconnect Google Drive.",
    success: isThai ? "เชื่อมต่อ Google Drive แล้ว" : "Google Drive connected successfully."
  };

  return messages[code] || code;
}

export function GoogleDrivePanel() {
  const { t, language } = useI18n();
  const isThai = language === "th";
  const searchParams = useSearchParams();
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [selectedFolder, setSelectedFolder] = useState("root");
  const [images, setImages] = useState<DriveImage[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [statusDebug, setStatusDebug] = useState<GoogleDriveStatusDebug | null>(null);

  const queryMessage = useMemo(() => {
    if (searchParams.get("success")) {
      return mapGoogleDriveMessage("success", isThai);
    }

    const error = searchParams.get("error");
    return error ? mapGoogleDriveMessage(error, isThai) : "";
  }, [searchParams, isThai]);

  async function loadFolders() {
    const statusResponse = await fetch("/api/google-drive/debug/status", { cache: "no-store" });
    const statusResult = await statusResponse.json().catch(() => null);
    if (statusResult?.ok && statusResult.data) {
      setStatusDebug(statusResult.data);
    }

    const response = await fetch("/api/google-drive/folders", { cache: "no-store" });
    const result = await response.json().catch(() => null);
    if (result.ok) {
      setFolders(result.data.folders);
      return true;
    }

    if (result.message) {
      setMessage(mapGoogleDriveMessage(result.code || result.message, isThai));
    }
    return false;
  }

  async function loadImages(folderId: string) {
    setSelectedFolder(folderId);
    const response = await fetch(`/api/google-drive/images?folderId=${folderId}`, { cache: "no-store" });
    const result = await response.json().catch(() => null);
    if (result.ok) {
      setImages(result.data.images);
    } else {
      setMessage(mapGoogleDriveMessage(result?.code || result?.message || t("commonRequestFailed"), isThai));
      setImages([]);
    }
  }

  useEffect(() => {
    setMessage(queryMessage);
    loadFolders().then((ok) => {
      if (ok) {
        loadImages("root");
      }
    });
  }, [queryMessage]);

  async function connect() {
    setLoading(true);
    const response = await fetch("/api/google-drive/oauth/url");
    const result = await response.json().catch(() => null);
    if (result.ok && result.data.url) {
      window.location.href = result.data.url;
      return;
    }

    setLoading(false);
    setMessage(mapGoogleDriveMessage(result?.code || result?.message || t("commonRequestFailed"), isThai));
  }

  return (
    <div className="stack">
      <button className="button" type="button" onClick={connect} disabled={loading}>
        {loading ? (isThai ? "กำลังเชื่อมต่อ..." : "Connecting...") : t("driveConnect")}
      </button>
      {message ? <p className="muted">{message}</p> : null}

      {statusDebug ? (
        <div
          style={{
            border: "1px solid rgba(15, 23, 42, 0.08)",
            background: "rgba(255, 255, 255, 0.72)",
            borderRadius: 16,
            padding: 16,
            display: "grid",
            gap: 6
          }}
        >
          <strong>{isThai ? "สถานะ Google Drive ของบัญชีนี้" : "Google Drive account status"}</strong>
          <div className="muted" style={{ display: "grid", gap: 4 }}>
            <span>{isThai ? "เชื่อมบัญชีแล้วหรือไม่" : "Connected account"}: <strong>{statusDebug.hasGoogleAccount ? (isThai ? "ใช่" : "Yes") : isThai ? "ไม่" : "No"}</strong></span>
            <span>{isThai ? "มี refresh token หรือไม่" : "Has refresh token"}: <strong>{statusDebug.hasRefreshToken ? (isThai ? "ใช่" : "Yes") : isThai ? "ไม่" : "No"}</strong></span>
            <span>{isThai ? "สถานะ credential" : "Credential status"}: <code>{statusDebug.credentialStatus}</code></span>
            <span>{isThai ? "รีเฟรช token ได้หรือไม่" : "Can refresh token"}: <strong>{statusDebug.canRefreshToken ? (isThai ? "ได้" : "Yes") : isThai ? "ไม่ได้" : "No"}</strong></span>
            <span>{isThai ? "รหัส error ล่าสุด" : "Last error code"}: <code>{statusDebug.lastErrorCode || "-"}</code></span>
          </div>
        </div>
      ) : null}

      <label className="label">
        {isThai ? "โฟลเดอร์ในไดรฟ์ของฉัน" : t("driveFolder")}
        <select className="select" value={selectedFolder} onChange={(event) => loadImages(event.target.value)}>
          <option value="root">{isThai ? "ไดรฟ์ของฉัน" : "My Drive"}</option>
          {folders.filter((folder) => folder.id !== "root").map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </select>
      </label>

      <div className="grid cols-3">
        {images.map((image) => (
          <div key={image.id} className="card">
            <strong>{image.name}</strong>
            <p className="muted">{image.id}</p>
            <a className="button-secondary" href={image.webContentLink || image.webViewLink || "#"} target="_blank" rel="noreferrer">
              {t("driveOpenImage")}
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
