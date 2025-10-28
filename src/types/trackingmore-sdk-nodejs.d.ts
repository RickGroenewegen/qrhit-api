declare module 'trackingmore-sdk-nodejs' {
  interface TrackingParams {
    tracking_number: string;
    courier_code: string;
    tracking_postal_code?: string;
    tracking_destination_country?: string;
    order_number?: string;
    customer_name?: string;
    title?: string;
    language?: string;
    note?: string;
  }

  interface TrackingMeta {
    code: number;
    message: string;
  }

  interface TrackingData {
    id: string;
    tracking_number: string;
    courier_code: string;
    [key: string]: any;
  }

  interface TrackingResponse {
    meta: TrackingMeta;
    data: TrackingData;
  }

  interface GetTrackingParams {
    tracking_numbers: string;
    courier_code: string;
    created_date_min?: string;
    created_date_max?: string;
  }

  interface GetTrackingResponse {
    meta: TrackingMeta;
    data: TrackingData[];
  }

  interface Trackings {
    createTracking(params: TrackingParams): Promise<TrackingResponse>;
    getTrackingResults(params: GetTrackingParams): Promise<GetTrackingResponse>;
  }

  class TrackingMore {
    constructor(apiKey: string);
    trackings: Trackings;
  }

  export default TrackingMore;
}
