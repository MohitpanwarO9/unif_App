export interface GoogleCredentials {
    web?: {
      client_id?: string;
      client_secret?: string;
      redirect_uris?: string[];
    };
  }

  export interface GoogleDriveAbout {
    user?: {
      displayName?: string | null;
      emailAddress?: string | null;
      permissionId?: string | null;
    };
  }

  export interface GoogleDriveFile {
    id: string;
    name: string;
    mimeType?: string;
    size?: string;
    modifiedTime?: string;
    webViewLink?: string;
    iconLink?: string;
    parents?: string[];
    trashed?: boolean;
  }

  export interface GoogleDriveFilesResponse {
    files?: GoogleDriveFile[];
    nextPageToken?: string;
    incompleteSearch?: boolean;
  }

  export interface StoredGoogleTokens {
    access_token?: string | null;
    refresh_token?: string | null;
    expiry_date?: number | null;
    token_type?: string | null;
    scope?: string;
    [key: string]: unknown;
  }

  export interface UploadBody {
    accountId?: string;
    fileName?: string;
    mimeType?: string;
    dataBase64?: string;
    parentId?: string;
  }

