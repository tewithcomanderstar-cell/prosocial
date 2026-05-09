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
  connected: boolean;
  hasGoogleAccount: boolean;
  hasRefreshToken: boolean;
  credentialStatus: string;
  tokenExpiresAt: string | null;
  canRefreshToken: boolean;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
  failingEndpoint: string | null;
  googleRedirectUri: string | null;
  hasGoogleClientId: boolean;
  hasGoogleClientSecret: boolean;
  workspaceIdPresent?: boolean;
};

type GoogleDriveProbe = {
  connected: boolean;
  canReadDrive: boolean;
  accountEmail: string | null;
  accountName: string | null;
  sampleFileCount: number;
  sampleImageCount: number;
  folderCount: number;
  sampleFiles: Array<{ id: string; name: string; mimeType?: string }>;
  sampleImages: Array<{ id: string; name: string; mimeType?: string }>;
  sampleFolders: Array<{ id: string; name: string }>;
  errors?: Array<{ step: string; code: string; message: string; details: string | null }>;
};

function mapGoogleDriveMessage(code: string, isThai: boolean) {
  const messages: Record<string, string> = {
    missing_code: isThai ? "Google ไม่ส่ง code กลับมา กรุณาลองเชื่อมต่อใหม่" : "Google did not return an authorization code.",
    google_oauth_cancelled: isThai
      ? "Google ไม่ได้ส่ง code กลับมา อาจยกเลิกการเชื่อมต่อไว้ กรุณาลองใหม่อีกครั้ง"
      : "Google did not return an authorization code. The connection may have been cancelled.",
    invalid_state: isThai
      ? "รอบการเชื่อม Google Drive หมดอายุหรือ state ไม่ตรงกัน กรุณากดเชื่อมใหม่อีกครั้ง"
      : "The Google Drive OAuth state was invalid or expired. Please start the connection again.",
    google_state_mismatch: isThai
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
    google_drive_not_connected: isThai
      ? "ยังไม่ได้เชื่อม Google Drive กับระบบนี้"
      : "Google Drive is not connected to this workspace yet.",
    google_refresh_token_missing: isThai
      ? "Google ไม่ส่ง refresh token กลับมา และระบบไม่มี token เดิมให้ใช้ กรุณากดเชื่อม Google Drive ใหม่อีกครั้ง"
      : "Google did not return a refresh token and no previous refresh token is available. Please reconnect Google Drive.",
    google_missing_env: isThai
      ? "ค่า Google OAuth บน production ยังตั้งไม่ครบ กรุณาตรวจ GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET และ redirect URI"
      : "Google OAuth is not fully configured in production.",
    google_redirect_uri_mismatch: isThai
      ? "Google redirect URI ไม่ตรงกับค่าที่ตั้งใน Google Cloud Console"
      : "Google redirect URI does not match the Google Cloud Console configuration.",
    google_token_exchange_failed: isThai
      ? "Google ส่ง code กลับมาแล้ว แต่ระบบแลก token ไม่สำเร็จ กรุณาตรวจ OAuth Client และ callback URI"
      : "Google returned the authorization code, but the token exchange failed.",
    google_credential_save_failed: isThai
      ? "ระบบรับ token จาก Google ได้แล้ว แต่บันทึก credential ไม่สำเร็จ"
      : "Google returned tokens, but saving the credential failed.",
    google_drive_fetch_failed: isThai
      ? "เชื่อม Google Drive แล้ว แต่ดึงโฟลเดอร์หรือรูปภาพไม่สำเร็จ กรุณาลองใหม่อีกครั้ง"
      : "Google Drive is connected, but folders or images could not be loaded.",
    unknown_error: isThai
      ? "ระบบยังอ่าน Google Drive ไม่สำเร็จ แต่ยังระบุสาเหตุไม่ได้"
      : "Google Drive could not be read yet, but the cause is not identified.",
    google_drive_token_invalid: isThai
      ? "Google Drive token เก่าถูกปฏิเสธ ระบบพยายามรีเฟรชแล้ว กรุณากดเชื่อม Google Drive ใหม่อีกครั้ง"
      : "Google Drive rejected the old token. Please reconnect Google Drive.",
    google_drive_scope_missing: isThai
      ? "สิทธิ์ของ Google Drive ยังไม่พอสำหรับการอ่านโฟลเดอร์หรือรูปภาพ กรุณาเชื่อมใหม่อีกครั้ง"
      : "The granted Google Drive scopes are not sufficient to read folders or images.",
    internal_error: isThai
      ? "ยังตรวจสอบ Google Drive ไม่สำเร็จ กรุณากดเชื่อม Google Drive ใหม่อีกครั้ง"
      : "Google Drive could not be verified. Please reconnect Google Drive.",
    workspace_not_found: isThai
      ? "ระบบยังสร้าง workspace สำหรับบัญชีนี้ไม่สำเร็จ กรุณาลองรีเฟรชหน้าแล้วเชื่อมใหม่อีกครั้ง"
      : "The workspace for this account is not ready yet. Refresh and try connecting again.",
    success: isThai ? "เชื่อมต่อ Google Drive แล้ว" : "Google Drive connected successfully."
  };

  return messages[code] || code;
}

function getConnectedDriveMessage(isThai: boolean) {
  return isThai
    ? "เชื่อม Google Drive สำเร็จแล้ว ระบบพร้อมใช้รูปจากไดรฟ์ของฉัน"
    : "Google Drive is connected. My Drive is ready to use.";
}

export function GoogleDrivePanel() {
  const { t, language } = useI18n();
  const isThai = language === "th";
  const searchParams = useSearchParams();
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [selectedFolder, setSelectedFolder] = useState("root");
  const [images, setImages] = useState<DriveImage[]>([]);
  const [message, setMessage] = useState("");
  const [imageMessage, setImageMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [statusDebug, setStatusDebug] = useState<GoogleDriveStatusDebug | null>(null);
  const [probe, setProbe] = useState<GoogleDriveProbe | null>(null);
  const [probeMessage, setProbeMessage] = useState("");

  const queryMessage = useMemo(() => {
    if (searchParams.get("success")) {
      return mapGoogleDriveMessage("success", isThai);
    }

    const error = searchParams.get("error");
    return error ? mapGoogleDriveMessage(error, isThai) : "";
  }, [searchParams, isThai]);

  async function loadFolders() {
    let hasUsableGoogleCredential = false;
    const statusResponse = await fetch("/api/google-drive/debug/status", { cache: "no-store", credentials: "include" });
    const statusResult = await statusResponse.json().catch(() => null);
    if (statusResult?.ok && statusResult.data) {
      setStatusDebug(statusResult.data);
      hasUsableGoogleCredential = Boolean(statusResult.data.connected && statusResult.data.hasRefreshToken);
      if (!hasUsableGoogleCredential) {
        setFolders([]);
        setImages([]);
        setImageMessage("");
        setMessage(
          mapGoogleDriveMessage(
            statusResult.data.hasGoogleAccount && !statusResult.data.hasRefreshToken
              ? "google_refresh_token_missing"
              : "google_drive_not_connected",
            isThai
          )
        );
        return false;
      }
      setMessage(getConnectedDriveMessage(isThai));
      if (searchParams.get("error")) {
        window.history.replaceState(null, "", window.location.pathname);
      }
    } else if (statusResult?.code || statusResult?.message) {
      setMessage(mapGoogleDriveMessage(statusResult.code || statusResult.message, isThai));
      return false;
    }

    const response = await fetch("/api/google-drive/folders", { cache: "no-store", credentials: "include" });
    const result = await response.json().catch(() => null);
    if (result?.ok) {
      setFolders(result.data.folders);
      setMessage(getConnectedDriveMessage(isThai));
      setImageMessage("");
      await loadImages("root");
      if (searchParams.get("error")) {
        window.history.replaceState(null, "", window.location.pathname);
      }
      return true;
    }

    const errorCode = result?.code || result?.message || "google_drive_fetch_failed";
    if (hasUsableGoogleCredential && errorCode === "google_drive_fetch_failed") {
      setFolders([{ id: "root", name: "My Drive" }]);
      setImages([]);
      setMessage(getConnectedDriveMessage(isThai));
      setImageMessage("");
      await loadImages("root");
      if (searchParams.get("error")) {
        window.history.replaceState(null, "", window.location.pathname);
      }
      return true;
    }

    if (result?.message) {
      setMessage(mapGoogleDriveMessage(errorCode, isThai));
    } else {
      setMessage(mapGoogleDriveMessage("google_drive_fetch_failed", isThai));
    }
    return false;
  }

  async function loadProbe() {
    const response = await fetch("/api/google-drive/debug/probe", { cache: "no-store", credentials: "include" });
    const result = await response.json().catch(() => null);
    if (result?.ok && result.data) {
      setProbe(result.data);
      setProbeMessage("");
      return;
    }

    setProbe(null);
    setProbeMessage(mapGoogleDriveMessage(result?.code || result?.message || "google_drive_fetch_failed", isThai));
  }

  async function loadImages(folderId: string) {
    setSelectedFolder(folderId);
    const response = await fetch(`/api/google-drive/images?folderId=${folderId}`, { cache: "no-store", credentials: "include" });
    const result = await response.json().catch(() => null);
    if (result?.ok) {
      setImages(result.data.images);
      setImageMessage("");
    } else {
      setImageMessage(
        folderId === "root"
          ? ""
          : mapGoogleDriveMessage(result?.code || result?.message || "google_drive_fetch_failed", isThai)
      );
      setImages([]);
    }
  }

  useEffect(() => {
    setMessage(queryMessage);
    setImageMessage("");
    loadFolders();
    loadProbe();
  }, [queryMessage]);

  async function connect() {
    setLoading(true);
    const response = await fetch("/api/google-drive/oauth/url", { cache: "no-store", credentials: "include" });
    const result = await response.json().catch(() => null);
    if (result?.ok && result.data?.url) {
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
            <span>{isThai ? "endpoint ที่ล้มล่าสุด" : "Last failing endpoint"}: <code>{statusDebug.failingEndpoint || "-"}</code></span>
            <span>{isThai ? "Google redirect URI ที่ใช้อยู่" : "Google redirect URI"}: <code>{statusDebug.googleRedirectUri || "-"}</code></span>
            <span>{isThai ? "มี GOOGLE_CLIENT_ID หรือไม่" : "Has GOOGLE_CLIENT_ID"}: <strong>{statusDebug.hasGoogleClientId ? (isThai ? "ใช่" : "Yes") : isThai ? "ไม่" : "No"}</strong></span>
            <span>{isThai ? "มี GOOGLE_CLIENT_SECRET หรือไม่" : "Has GOOGLE_CLIENT_SECRET"}: <strong>{statusDebug.hasGoogleClientSecret ? (isThai ? "ใช่" : "Yes") : isThai ? "ไม่" : "No"}</strong></span>
            <span>{isThai ? "มี workspace หรือไม่" : "Workspace present"}: <strong>{statusDebug.workspaceIdPresent ? (isThai ? "มี" : "Yes") : isThai ? "ไม่มี" : "No"}</strong></span>
            <span>{isThai ? "รหัส error ล่าสุด" : "Last error code"}: <code>{statusDebug.lastErrorCode || "-"}</code></span>
          </div>
        </div>
      ) : null}

      {probe || probeMessage ? (
        <div
          style={{
            border: "1px solid rgba(37, 99, 235, 0.16)",
            background: "rgba(239, 246, 255, 0.72)",
            borderRadius: 16,
            padding: 16,
            display: "grid",
            gap: 8
          }}
        >
          <strong>{isThai ? "ผลตรวจข้อมูลใน Google Drive" : "Google Drive data probe"}</strong>
          {probe ? (
            <div className="muted" style={{ display: "grid", gap: 4 }}>
              <span>{isThai ? "บัญชี Drive" : "Drive account"}: <strong>{probe.accountEmail || probe.accountName || "-"}</strong></span>
              <span>{isThai ? "ไฟล์ตัวอย่างที่อ่านได้" : "Readable sample files"}: <strong>{probe.sampleFileCount}</strong></span>
              <span>{isThai ? "รูปภาพตัวอย่างที่อ่านได้" : "Readable sample images"}: <strong>{probe.sampleImageCount}</strong></span>
              <span>{isThai ? "โฟลเดอร์ที่อ่านได้" : "Readable folders"}: <strong>{probe.folderCount}</strong></span>
              {probe.folderCount === 0 && probe.sampleFileCount === 0 ? (
                <span>
                  {isThai
                    ? "Google API ตอบสำเร็จ แต่ไม่คืนไฟล์/โฟลเดอร์ให้ระบบ อาจเป็นบัญชี Drive คนละอัน หรือสิทธิ์ Drive ของ OAuth ยังไม่ครอบคลุมข้อมูลนี้"
                    : "Google API responded successfully but returned no files or folders. This may be a different Drive account or an OAuth access scope/data visibility issue."}
                </span>
              ) : null}
              {probe.errors?.length ? (
                <span>
                  {isThai ? "รายละเอียด step ที่ยังอ่านไม่ได้" : "Unreadable probe steps"}:{" "}
                  <code>
                    {probe.errors
                      .map((error) => `${error.step}:${error.code}${error.details ? ` (${error.details})` : ""}`)
                      .join(", ")}
                  </code>
                </span>
              ) : null}
            </div>
          ) : (
            <p className="muted">{probeMessage}</p>
          )}
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
      {imageMessage ? <p className="muted">{imageMessage}</p> : null}

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
