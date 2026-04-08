"use client";

import { useEffect, useState } from "react";
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

export function GoogleDrivePanel() {
  const { t } = useI18n();
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [selectedFolder, setSelectedFolder] = useState("");
  const [images, setImages] = useState<DriveImage[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch("/api/google-drive/folders")
      .then((res) => res.json())
      .then((result) => {
        if (result.ok) {
          setFolders(result.data.folders);
        }
      });
  }, []);

  async function connect() {
    const response = await fetch("/api/google-drive/oauth/url");
    const result = await response.json();
    if (result.ok && result.data.url) {
      window.location.href = result.data.url;
      return;
    }

    setMessage(result.message || t("commonRequestFailed"));
  }

  async function loadImages(folderId: string) {
    setSelectedFolder(folderId);
    const response = await fetch(`/api/google-drive/images?folderId=${folderId}`);
    const result = await response.json();
    if (result.ok) {
      setImages(result.data.images);
    }
  }

  return (
    <div className="stack">
      <button className="button" type="button" onClick={connect}>
        {t("driveConnect")}
      </button>
      {message ? <p className="muted">{message}</p> : null}

      <label className="label">
        {t("driveFolder")}
        <select className="select" value={selectedFolder} onChange={(event) => loadImages(event.target.value)}>
          <option value="">{t("driveSelectFolder")}</option>
          {folders.map((folder) => (
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
            <a className="button-secondary" href={image.webContentLink || image.webViewLink || "#"}>
              {t("driveOpenImage")}
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
