import { StatusBar } from 'expo-status-bar';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  RefreshControl,
  SafeAreaView,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebViewNavigation } from 'react-native-webview';

const BASE_URL = 'https://maybe-someone-saw.vercel.app/';
const ALLOWED_HOSTS = ['maybe-someone-saw.vercel.app', 'open.spotify.com', 'spotify.com', 'accounts.spotify.com'];

export default function App() {
  const webRef = useRef<WebView | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hasError, setHasError] = useState(false);

  const baseHost = useMemo(() => {
    try {
      return new URL(BASE_URL).host;
    } catch {
      return '';
    }
  }, []);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setHasError(false);
    webRef.current?.reload();
    setTimeout(() => setRefreshing(false), 900);
  }, []);

  const retry = useCallback(() => {
    setHasError(false);
    setLoading(true);
    webRef.current?.reload();
  }, []);

  const openExternal = useCallback(async (url: string) => {
    try {
      const supported = await Linking.canOpenURL(url);
      if (supported) await Linking.openURL(url);
    } catch {}
  }, []);

  const isExternalToBase = useCallback(
    (url: string) => {
      try {
        const u = new URL(url);
        if (ALLOWED_HOSTS.includes(u.host)) return false;
        if (baseHost && u.host === baseHost) return false;
        return true;
      } catch {
        return false;
      }
    },
    [baseHost]
  );

  const onShouldStartLoadWithRequest = useCallback(
    (req: any) => {
      const url = typeof req?.url === 'string' ? req.url : '';
      if (!url) return true;

      const isTopFrame = typeof req?.isTopFrame === 'boolean' ? req.isTopFrame : true;

      if (url.startsWith('spotify:') || url.startsWith('intent:')) {
        void openExternal(url);
        return false;
      }

      if (url.startsWith('mailto:') || url.startsWith('tel:') || url.startsWith('sms:')) {
        void openExternal(url);
        return false;
      }

      if (url.startsWith('http://') || url.startsWith('https://')) {
        if (isTopFrame) {
          try {
            const u = new URL(url);
            const host = u.host.toLowerCase();
            if ((host === 'open.spotify.com' || host === 'spotify.com') && !u.pathname.startsWith('/embed/')) {
              void openExternal(url);
              return false;
            }
          } catch {}
        }
        if (isTopFrame && isExternalToBase(url)) {
          void openExternal(url);
          return false;
        }
      }

      return true;
    },
    [isExternalToBase, openExternal]
  );

  const onNavigationStateChange = useCallback((nav: WebViewNavigation) => {
    const url = typeof nav?.url === 'string' ? nav.url : '';
    if (!url) return;
    if (url.startsWith('mailto:') || url.startsWith('tel:') || url.startsWith('sms:')) {
      void openExternal(url);
    }
  }, [openExternal]);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      {hasError ? (
        <View style={styles.errorWrap}>
          <Text style={styles.errorTitle}>Connection error</Text>
          <Text style={styles.errorBody}>We couldn’t load the site.</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={retry}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.webWrap}>
          <WebView
            ref={(r) => {
              webRef.current = r;
            }}
            source={{ uri: BASE_URL }}
            onLoadStart={() => {
              setLoading(true);
              setHasError(false);
            }}
            onLoadEnd={() => {
              setLoading(false);
              setRefreshing(false);
            }}
            onError={() => {
              setHasError(true);
              setLoading(false);
              setRefreshing(false);
            }}
            onHttpError={() => {
              setHasError(true);
              setLoading(false);
              setRefreshing(false);
            }}
            startInLoadingState
            originWhitelist={['*']}
            pullToRefreshEnabled={Platform.OS === 'android'}
            onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
            onNavigationStateChange={onNavigationStateChange}
            allowsBackForwardNavigationGestures
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            javaScriptEnabled
            domStorageEnabled
            setSupportMultipleWindows={false}
          />

          {Platform.OS !== 'android' ? (
            <View style={styles.iosRefreshOverlay} pointerEvents="box-none">
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#fbf1c7" />
            </View>
          ) : null}

          {loading ? (
            <View style={styles.loadingOverlay} pointerEvents="none">
              <ActivityIndicator size="large" color="#fbf1c7" />
            </View>
          ) : null}
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#1d2021',
    paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight ?? 0 : 0
  },
  webWrap: {
    flex: 1
  },
  loadingOverlay: {
    position: 'absolute',
    inset: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(29,32,33,0.35)'
  },
  errorWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#fbf1c7',
    marginBottom: 8
  },
  errorBody: {
    fontSize: 13,
    color: '#a89984',
    marginBottom: 14
  },
  retryBtn: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: 'rgba(60,56,54,0.75)'
  },
  retryText: {
    color: '#fbf1c7',
    fontWeight: '600'
  },
  iosRefreshOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 0
  }
});
