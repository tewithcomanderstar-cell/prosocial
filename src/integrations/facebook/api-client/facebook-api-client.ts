export class FacebookApiClient {
  async publishPhoto(_input: { accessToken: string; pageId: string; message: string; mediaUrl?: string }) {
    throw new Error('FacebookApiClient.publishPhoto is not implemented in phase 3');
  }
}
