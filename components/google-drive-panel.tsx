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
    provider_not_connected: isThai
      ? "ยังไม่ได้เชื่อม Google Drive กับระบบนี้"
      : "Google Drive is not connected to this workspace yet.",
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

  const queryMessage = useMemo(() => {
    if (searchParams.get("success")) {
      return mapGoogleDriveMessage("success", isThai);
    }

    const error = searchParams.get("error");
    return error ? mapGoogleDriveMessage(error, isThai) : "";
  }, [searchParams, isThai]);

  async function loadFolders() {
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
