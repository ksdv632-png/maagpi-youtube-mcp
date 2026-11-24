import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withAuthRetry } from "../auth/middleware.js";
import { buildAnalyticsClient } from "../youtube/client.js";
import {
  queryVideoMetrics, queryChannelMetrics, queryTopVideos,
  queryAudienceRetention, queryRevenueReport,
} from "../youtube/analytics.js";
import { getCached, setCached } from "../quota/cache.js";
import { trackQuota, getQuotaSummary } from "../quota/tracker.js";
import { QUOTA_COSTS } from "../quota/constants.js";
import { YouTubeMcpError } from "../errors/types.js";
import { buildErrorResponse, toMcpError } from "../errors/handlers.js";
import { toolResult } from "./result.js";
import { YouTubeMcpErrorCode } from "../errors/codes.js";
import {
  VideoMetricsSchema, ChannelMetricsSchema, TopVideosSchema,
  AudienceRetentionSchema, RevenueReportSchema,
} from "../schemas/analytics.js";

const ANALYTICS_METHOD = "youtubeAnalytics.reports.query";
const COST = QUOTA_COSTS[ANALYTICS_METHOD] ?? 1;

export function registerAnalyticsTools(server: McpServer): void {
  server.registerTool(
    "youtube_analytics_video_metrics",
    { description: "Query YouTube Analytics for detailed per-video metrics (views, watch time, retention, CTR, etc.).", inputSchema: VideoMetricsSchema },
    async (params) => {
      try {
        const cacheKey = params as Record<string, unknown>;
        const cached = getCached(ANALYTICS_METHOD, cacheKey);
        if (cached) return toolResult({ success: true, data: cached, quota: getQuotaSummary(0), cached: true });

        const result = await withAuthRetry(async (auth) => {
          const analytics = buildAnalyticsClient(auth);
          return queryVideoMetrics(
            analytics, params.videoId, params.startDate, params.endDate,
            params.metrics as string[], params.dimensions as string[] | undefined
          );
        }, params.channel);
        trackQuota(ANALYTICS_METHOD, COST);
        setCached(ANALYTICS_METHOD, cacheKey, result);
        return toolResult({ success: true, data: result, quota: getQuotaSummary(COST) });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );

  server.registerTool(
    "youtube_analytics_channel_metrics",
    { description: "Query channel-level analytics: views, subscribers, watch time, revenue, and more.", inputSchema: ChannelMetricsSchema },
    async (params) => {
      try {
        const cacheKey = params as Record<string, unknown>;
        const cached = getCached(ANALYTICS_METHOD, cacheKey);
        if (cached) return toolResult({ success: true, data: cached, quota: getQuotaSummary(0), cached: true });

        const result = await withAuthRetry(async (auth) => {
          const analytics = buildAnalyticsClient(auth);
          return queryChannelMetrics(
            analytics, params.startDate, params.endDate,
            params.metrics as string[], params.dimensions as string[] | undefined,
            params.filters, params.maxResults
          );
        }, params.channel);
        trackQuota(ANALYTICS_METHOD, COST);
        setCached(ANALYTICS_METHOD, cacheKey, result);
        return toolResult({ success: true, data: result, quota: getQuotaSummary(COST) });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );

  server.registerTool(
    "youtube_analytics_top_videos",
    { description: "Get top performing videos for a date range ranked by a specific metric.", inputSchema: TopVideosSchema },
    async (params) => {
      try {
        const cacheKey = params as Record<string, unknown>;
        const cached = getCached(ANALYTICS_METHOD, cacheKey);
        if (cached) return toolResult({ success: true, data: cached, quota: getQuotaSummary(0), cached: true });

        const result = await withAuthRetry(async (auth) => {
          const analytics = buildAnalyticsClient(auth);
          return queryTopVideos(
            analytics, params.startDate, params.endDate, params.metric, params.maxResults, params.filters
          );
        }, params.channel);
        trackQuota(ANALYTICS_METHOD, COST);
        setCached(ANALYTICS_METHOD, cacheKey, result);
        return toolResult({ success: true, data: result, quota: getQuotaSummary(COST) });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );

  server.registerTool(
    "youtube_analytics_audience_retention",
    { description: "Get audience retention curve data for a specific video showing where viewers drop off.", inputSchema: AudienceRetentionSchema },
    async (params) => {
      try {
        const cacheKey = params as Record<string, unknown>;
        const cached = getCached(ANALYTICS_METHOD, cacheKey);
        if (cached) return toolResult({ success: true, data: cached, quota: getQuotaSummary(0), cached: true });

        const result = await withAuthRetry(async (auth) => {
          const analytics = buildAnalyticsClient(auth);
          return queryAudienceRetention(
            analytics, params.videoId, params.startDate, params.endDate
          );
        }, params.channel);
        trackQuota(ANALYTICS_METHOD, COST);
        setCached(ANALYTICS_METHOD, cacheKey, result);
        return toolResult({ success: true, data: result, quota: getQuotaSummary(COST) });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );

  server.registerTool(
    "youtube_analytics_revenue_report",
    { description: "Get revenue report including estimated revenue, ad revenue, and gross revenue.", inputSchema: RevenueReportSchema },
    async (params) => {
      try {
        const cacheKey = params as Record<string, unknown>;
        const cached = getCached(ANALYTICS_METHOD, cacheKey);
        if (cached) return toolResult({ success: true, data: cached, quota: getQuotaSummary(0), cached: true });

        const result = await withAuthRetry(async (auth) => {
          const analytics = buildAnalyticsClient(auth);
          return queryRevenueReport(
            analytics, params.startDate, params.endDate, params.dimensions as string[] | undefined
          );
        }, params.channel);
        trackQuota(ANALYTICS_METHOD, COST);
        setCached(ANALYTICS_METHOD, cacheKey, result);
        return toolResult({ success: true, data: result, quota: getQuotaSummary(COST) });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );
}
