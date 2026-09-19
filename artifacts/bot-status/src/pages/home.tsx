import { getHealthCheckQueryKey, useHealthCheck, getGetPublicBotStatusQueryKey, useGetPublicBotStatus } from "@workspace/api-client-react";
import { Server, Activity, ShieldAlert, TerminalSquare, RefreshCw, Clock, CheckCircle2, AlertTriangle, XCircle, ChevronRight, BarChart } from "lucide-react";
import { SiDiscord } from "react-icons/si";
import { useEffect, useState, useRef } from "react";
import { motion } from "framer-motion";

export default function Home() {
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const { data, isLoading, isError, refetch, isFetching } = useHealthCheck({
    query: {
      queryKey: getHealthCheckQueryKey(),
      refetchInterval: 15000,
    }
  });

  const { data: botData, isLoading: isBotLoading, isError: isBotError, refetch: refetchBot, isFetching: isBotFetching } = useGetPublicBotStatus({
    query: {
      queryKey: getGetPublicBotStatusQueryKey(),
      refetchInterval: 15000,
    }
  });

  const handleRefresh = () => {
    refetch();
    refetchBot();
  };

  const apiStatus = isLoading ? 'CONNECTING' : isError ? 'UNREACHABLE' : 'OPERATIONAL';
  
  let botStatusText = 'UNKNOWN';
  let BotStatusIcon = ShieldAlert;
  let botStatusColorClass = 'text-amber-700 dark:text-amber-500';
  let botBgClass = 'bg-[#5865F2]/5 border-[#5865F2]/20 text-[#5865F2]';
  let botActionText = 'Check API Connection';

  if (isBotLoading) {
    botStatusText = 'CONNECTING';
    BotStatusIcon = RefreshCw;
    botStatusColorClass = 'text-muted-foreground';
    botBgClass = 'bg-secondary/50 border-border text-muted-foreground';
    botActionText = 'Awaiting telemetry...';
  } else if (isBotError) {
    botStatusText = 'UNREACHABLE';
    BotStatusIcon = XCircle;
    botStatusColorClass = 'text-destructive';
    botBgClass = 'bg-destructive/10 border-destructive/20 text-destructive';
    botActionText = 'Investigate backend logs';
  } else if (botData) {
    switch (botData.status) {
      case 'online':
        botStatusText = 'ONLINE';
        BotStatusIcon = CheckCircle2;
        botStatusColorClass = 'text-emerald-700 dark:text-emerald-500';
        botBgClass = 'bg-emerald-500/10 border-emerald-500/20 text-emerald-700 dark:text-emerald-500';
        botActionText = 'None (Nominal)';
        break;
      case 'maintenance':
        botStatusText = 'MAINTENANCE';
        BotStatusIcon = AlertTriangle;
        botStatusColorClass = 'text-amber-700 dark:text-amber-500';
        botBgClass = 'bg-amber-500/10 border-amber-500/20 text-amber-700 dark:text-amber-500';
        botActionText = 'Scheduled or forced downtime';
        break;
      case 'offline':
        botStatusText = 'OFFLINE';
        BotStatusIcon = XCircle;
        botStatusColorClass = 'text-destructive';
        botBgClass = 'bg-destructive/10 border-destructive/20 text-destructive';
        botActionText = 'Check bot process host';
        break;
    }
  }

  const timeString = currentTime.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';

  return (
    <div className="flex flex-col gap-10">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="flex flex-col gap-4 border-b border-border pb-8"
      >
        <div className="flex items-center gap-3">
          <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-3 py-1 text-xs font-mono border border-primary/20">
            <Activity className="w-3.5 h-3.5" />
            LIVE TELEMETRY
          </div>
          <div className="inline-flex items-center gap-1.5 bg-secondary/80 px-3 py-1 text-xs font-mono border border-border text-muted-foreground">
            <Clock className="w-3.5 h-3.5" />
            {timeString}
          </div>
        </div>

        <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-foreground">
          System Status
        </h1>
        <p className="text-muted-foreground max-w-2xl text-lg leading-relaxed">
          Real-time operational status for the Quartermaster infrastructure. This surface provides transparency into subsystem connectivity and backend gateway health.
        </p>
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* API Status Card */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="border border-border bg-card p-6 flex flex-col relative group"
        >
          <div className="absolute top-0 right-0 p-4">
             <button
               onClick={handleRefresh}
              className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 p-2 cursor-pointer rounded bg-secondary/50 hover:bg-secondary"
              disabled={isFetching || isBotFetching}
              data-testid="button-refresh-api"
              title="Force manual refresh"
            >
              <RefreshCw className={`w-4 h-4 ${(isFetching || isBotFetching) ? 'animate-spin' : ''}`} />
            </button>
          </div>

          <div className="flex items-start justify-between mb-8">
            <div className="flex items-center gap-4">
              <div className={`p-3 border rounded-sm ${isLoading ? 'bg-secondary/50 border-border text-muted-foreground' : isError ? 'bg-destructive/10 border-destructive/20 text-destructive' : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-700 dark:text-emerald-500'}`}>
                <Server className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-semibold text-lg tracking-tight">API Uplink</h2>
                <div className="font-mono text-xs text-muted-foreground uppercase tracking-widest mt-1">Core Infrastructure</div>
              </div>
            </div>
          </div>

          <div className="mt-auto space-y-0 text-sm">
            <div className="flex items-center justify-between py-3 border-t border-border">
              <span className="font-medium text-muted-foreground">Connection State</span>
              <span className="flex items-center gap-2">
                {isLoading ? (
                  <RefreshCw className="w-4 h-4 animate-spin text-muted-foreground" />
                ) : isError ? (
                  <XCircle className="w-4 h-4 text-destructive" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 text-emerald-700 dark:text-emerald-500" />
                )}
                <span className={`font-mono font-bold ${isLoading ? 'text-muted-foreground' : isError ? 'text-destructive' : 'text-emerald-700 dark:text-emerald-500'}`}>
                  {apiStatus}
                </span>
              </span>
            </div>

            <div className="flex items-center justify-between py-3 border-t border-border">
              <span className="font-medium text-muted-foreground">Response Payload</span>
              <span className="font-mono text-muted-foreground bg-secondary/50 px-2 py-0.5 border border-border rounded-sm text-xs">
                {isLoading ? '...' : isError ? 'ERR_CONNECTION_REFUSED' : (data?.status ? `status: ${data.status}` : 'OK')}
              </span>
            </div>

            <div className="flex items-center justify-between py-3 border-t border-border">
              <span className="font-medium text-muted-foreground">Last Telemetry</span>
              <span className="font-mono text-muted-foreground text-xs">
                {isFetching ? 'Synchronizing...' : timeString}
              </span>
            </div>
          </div>
        </motion.div>

        {/* Discord Gateway Card */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.2 }}
          className="border border-border bg-card p-6 flex flex-col relative group"
        >
          <div className="absolute top-0 right-0 p-4">
             <button
               onClick={handleRefresh}
              className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 p-2 cursor-pointer rounded bg-secondary/50 hover:bg-secondary"
              disabled={isFetching || isBotFetching}
              data-testid="button-refresh-bot"
              title="Force manual refresh"
            >
              <RefreshCw className={`w-4 h-4 ${(isFetching || isBotFetching) ? 'animate-spin' : ''}`} />
            </button>
          </div>

          <div className="flex items-start justify-between mb-8">
            <div className="flex items-center gap-4">
              <div className={`p-3 border rounded-sm transition-colors ${botBgClass}`}>
                <SiDiscord className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-semibold text-lg tracking-tight">Discord Gateway</h2>
                <div className="font-mono text-xs text-muted-foreground uppercase tracking-widest mt-1">Bot Process</div>
              </div>
            </div>
          </div>

          <div className="mt-auto space-y-0 text-sm">
            <div className="flex items-center justify-between py-3 border-t border-border">
              <span className="font-medium text-muted-foreground">Connection State</span>
              <span className="flex items-center gap-2">
                <BotStatusIcon className={`w-4 h-4 ${botStatusColorClass} ${isBotLoading ? 'animate-spin' : ''}`} />
                <span className={`font-mono font-bold ${botStatusColorClass}`}>
                  {botStatusText}
                </span>
              </span>
            </div>

            <div className="flex items-center justify-between py-3 border-t border-border">
              <span className="font-medium text-muted-foreground">Gateway Heartbeat</span>
              <span className="font-mono text-muted-foreground bg-secondary/50 px-2 py-0.5 border border-border rounded-sm text-xs">
                {isBotLoading ? '...' : isBotError ? 'ERR_CONNECTION_REFUSED' : (botData?.checkedAt ? new Date(botData.checkedAt).toISOString().replace('T', ' ').substring(0, 19) + ' UTC' : 'UNKNOWN')}
              </span>
            </div>

            <div className="flex items-center justify-between py-3 border-t border-border">
              <span className="font-medium text-muted-foreground">Action Required</span>
              <span className="font-mono text-muted-foreground text-xs">
                {botActionText}
              </span>
            </div>
          </div>
        </motion.div>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.3 }}
        className="mt-4 p-4 border border-border bg-secondary/20 text-sm text-muted-foreground flex items-start gap-3 rounded-sm"
      >
        <BarChart className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
        <div>
          <strong className="text-foreground font-medium block mb-1">Operational Transparency</strong>
          Status checks use separate health endpoints designed to minimize their impact on core bot performance. The data represented here updates automatically every 15 seconds.
        </div>
      </motion.div>
    </div>
  );
}
