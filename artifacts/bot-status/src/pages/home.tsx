import { getHealthCheckQueryKey, useHealthCheck, getGetPublicBotStatusQueryKey, useGetPublicBotStatus } from "@workspace/api-client-react";
import { Server, Activity, ShieldAlert, TerminalSquare, RefreshCw, Clock, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { SiDiscord } from "react-icons/si";
import { useEffect, useState } from "react";
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
  let botStatusColorClass = 'text-amber-600';
  let botBgClass = 'bg-[#5865F2]/10 border-[#5865F2]/30 text-[#5865F2]';
  let botActionText = 'Check API Connection';

  if (isBotLoading) {
    botStatusText = 'CONNECTING';
    BotStatusIcon = RefreshCw;
    botStatusColorClass = 'text-muted-foreground';
    botBgClass = 'bg-secondary border-border text-muted-foreground';
    botActionText = 'Awaiting telemetry...';
  } else if (isBotError) {
    botStatusText = 'UNREACHABLE';
    BotStatusIcon = XCircle;
    botStatusColorClass = 'text-destructive';
    botBgClass = 'bg-destructive/10 border-destructive/30 text-destructive';
    botActionText = 'Investigate backend logs';
  } else if (botData) {
    switch (botData.status) {
      case 'online':
        botStatusText = 'ONLINE';
        BotStatusIcon = CheckCircle2;
        botStatusColorClass = 'text-emerald-600';
        botBgClass = 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600';
        botActionText = 'None (Nominal)';
        break;
      case 'maintenance':
        botStatusText = 'MAINTENANCE';
        BotStatusIcon = AlertTriangle;
        botStatusColorClass = 'text-amber-600 dark:text-amber-500';
        botBgClass = 'bg-amber-500/10 border-amber-500/30 text-amber-600 dark:text-amber-500';
        botActionText = 'Scheduled or forced downtime';
        break;
      case 'offline':
        botStatusText = 'OFFLINE';
        BotStatusIcon = XCircle;
        botStatusColorClass = 'text-destructive';
        botBgClass = 'bg-destructive/10 border-destructive/30 text-destructive';
        botActionText = 'Check bot process host';
        break;
    }
  }

  const timeString = currentTime.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';

  return (
     <div className="min-h-[100dvh] bg-background text-foreground flex flex-col font-sans selection:bg-primary/20 bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:16px_16px]">
       <div className="fixed inset-0 pointer-events-none opacity-[0.4] bg-[radial-gradient(hsl(var(--foreground)/0.15)_1px,transparent_1px)] [background-size:24px_24px] z-0"></div>

       <header className="border-b border-border bg-background/80 px-6 py-4 flex items-center justify-between sticky top-0 z-10 backdrop-blur-md">
         <div className="flex items-center gap-3">
           <TerminalSquare className="w-5 h-5 text-primary" />
           <div className="font-mono font-bold tracking-tight text-sm">
             QUARTERMASTER <span className="text-muted-foreground mx-2">/</span> SYSCOM
           </div>
         </div>
         <div className="flex items-center gap-4 text-sm font-mono text-muted-foreground hidden sm:flex">
           <div className="flex items-center gap-1.5 bg-secondary px-3 py-1 border border-border text-xs">
             <Clock className="w-3.5 h-3.5" />
             {timeString}
           </div>
         </div>
       </header>

       <main className="flex-1 p-6 md:p-12 max-w-5xl mx-auto w-full flex flex-col gap-10 z-10 relative">
         <motion.div 
           initial={{ opacity: 0, y: 10 }}
           animate={{ opacity: 1, y: 0 }}
           transition={{ duration: 0.4 }}
           className="flex flex-col gap-3"
         >
           <div className="inline-flex items-center gap-2 bg-secondary text-secondary-foreground w-fit px-3 py-1 text-xs font-mono border border-border">
             <Activity className="w-3.5 h-3.5" />
             LIVE TELEMETRY
           </div>
           <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-foreground uppercase">
             Network Status
           </h1>
           <p className="text-muted-foreground max-w-2xl text-lg mt-2">
             Real-time operational status for the Quartermaster bot infrastructure.
           </p>
         </motion.div>

         <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
           {/* API Status Card */}
           <motion.div
             initial={{ opacity: 0, y: 10 }}
             animate={{ opacity: 1, y: 0 }}
             transition={{ duration: 0.4, delay: 0.1 }}
             className="border border-border bg-card p-6 md:p-8 flex flex-col relative group shadow-sm hover:shadow-md transition-shadow"
           >
             <div className="absolute top-0 right-0 p-6 opacity-0 group-hover:opacity-100 transition-opacity focus-within:opacity-100">
                <button
                  onClick={handleRefresh}
                 className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 border border-border p-2 bg-background hover:bg-secondary cursor-pointer"
                 disabled={isFetching || isBotFetching}
                 data-testid="button-refresh-api"
                 title="Force manual refresh"
               >
                 <RefreshCw className={`w-4 h-4 ${(isFetching || isBotFetching) ? 'animate-spin' : ''}`} />
               </button>
             </div>
             
             <div className="flex items-start justify-between mb-8">
               <div className="flex items-center gap-4">
                 <div className={`p-3 border ${isLoading ? 'bg-secondary border-border' : isError ? 'bg-destructive/10 border-destructive/30 text-destructive' : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600'}`}>
                   <Server className="w-6 h-6" />
                 </div>
                 <div>
                   <h2 className="font-semibold text-xl tracking-tight">API Uplink</h2>
                   <div className="font-mono text-xs text-muted-foreground uppercase tracking-widest mt-1">Core Infrastructure</div>
                 </div>
               </div>
             </div>

             <div className="mt-auto space-y-0 text-sm">
               <div className="flex items-center justify-between py-4 border-t border-border">
                 <span className="font-medium text-muted-foreground">Connection State</span>
                 <span className="flex items-center gap-2">
                   {isLoading ? (
                     <RefreshCw className="w-4 h-4 animate-spin text-muted-foreground" />
                   ) : isError ? (
                     <XCircle className="w-4 h-4 text-destructive" />
                   ) : (
                     <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                   )}
                   <span className={`font-mono font-bold ${isLoading ? 'text-muted-foreground' : isError ? 'text-destructive' : 'text-emerald-600'}`}>
                     {apiStatus}
                   </span>
                 </span>
               </div>
               
               <div className="flex items-center justify-between py-4 border-t border-border">
                 <span className="font-medium text-muted-foreground">Response Payload</span>
                 <span className="font-mono text-muted-foreground bg-secondary px-2 py-0.5 border border-border">
                   {isLoading ? '...' : isError ? 'ERR_CONNECTION_REFUSED' : (data?.status ? `status: ${data.status}` : 'OK')}
                 </span>
               </div>

               <div className="flex items-center justify-between py-4 border-t border-b border-border">
                 <span className="font-medium text-muted-foreground">Last Telemetry</span>
                 <span className="font-mono text-muted-foreground">
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
             className="border border-border bg-card p-6 md:p-8 flex flex-col relative group shadow-sm hover:shadow-md transition-shadow"
           >
             <div className="absolute top-0 right-0 p-6 opacity-0 group-hover:opacity-100 transition-opacity focus-within:opacity-100">
                <button
                  onClick={handleRefresh}
                 className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 border border-border p-2 bg-background hover:bg-secondary cursor-pointer"
                 disabled={isFetching || isBotFetching}
                 data-testid="button-refresh-bot"
                 title="Force manual refresh"
               >
                 <RefreshCw className={`w-4 h-4 ${(isFetching || isBotFetching) ? 'animate-spin' : ''}`} />
               </button>
             </div>

             <div className="flex items-start justify-between mb-8">
               <div className="flex items-center gap-4">
                 <div className={`p-3 border transition-colors ${botBgClass}`}>
                   <SiDiscord className="w-6 h-6" />
                 </div>
                 <div>
                   <h2 className="font-semibold text-xl tracking-tight">Discord Gateway</h2>
                   <div className="font-mono text-xs text-muted-foreground uppercase tracking-widest mt-1">Bot Process</div>
                 </div>
               </div>
             </div>

             <div className="mt-auto space-y-0 text-sm">
               <div className="flex items-center justify-between py-4 border-t border-border">
                 <span className="font-medium text-muted-foreground">Connection State</span>
                 <span className="flex items-center gap-2">
                   <BotStatusIcon className={`w-4 h-4 ${botStatusColorClass} ${isBotLoading ? 'animate-spin' : ''}`} />
                   <span className={`font-mono font-bold ${botStatusColorClass}`}>
                     {botStatusText}
                   </span>
                 </span>
               </div>
               
               <div className="flex items-center justify-between py-4 border-t border-border">
                 <span className="font-medium text-muted-foreground">Gateway Heartbeat</span>
                 <span className="font-mono text-muted-foreground bg-secondary px-2 py-0.5 border border-border">
                   {isBotLoading ? '...' : isBotError ? 'ERR_CONNECTION_REFUSED' : (botData?.checkedAt ? new Date(botData.checkedAt).toISOString().replace('T', ' ').substring(0, 19) + ' UTC' : 'UNKNOWN')}
                 </span>
               </div>

               <div className="flex items-center justify-between py-4 border-t border-b border-border">
                 <span className="font-medium text-muted-foreground">Action Required</span>
                 <span className="font-mono text-muted-foreground">
                   {botActionText}
                 </span>
               </div>
             </div>
           </motion.div>
         </div>
       </main>
     </div>
  );
}
