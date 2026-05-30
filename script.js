/* ====================================================
   「ひろしまの和」実際の行政区域境界 (Leaflet & GeoJSON) マップロジック
   ==================================================== */

// ----------------------------------------------------
// 1. グローバル状態・Leaflet 地図管理
// ----------------------------------------------------
let map = null;
let geojsonLayer = null;
let activeMode = 'municipality'; // 'municipality' または 'ward'

let appData = {
  municipality: {}, // 市町村モードデータ
  ward: {}          // 広島市区モードデータ
};

// キャッシュ用GeoJSONデータ
let muniGeoJsonData = null;
let wardGeoJsonData = null;

// 登録可能な地域リスト (プルダウン動的生成およびマッピング検証用)
const REGION_LIST = {
  municipality: [
    "広島市", "呉市", "竹原市", "三原市", "尾道市", "福山市", "府中市", "三次市", 
    "庄原市", "大竹市", "東広島市", "廿日市市", "安芸高田市", "江田島市", 
    "府中町", "海田町", "熊野町", "坂町", "安芸太田町", "北広島町", "大崎上島町", 
    "世羅町", "神石高原町"
  ],
  ward: [
    "中区", "東区", "南区", "西区", "安佐南区", "安佐北区", "安芸区", "佐伯区"
  ]
};

// ----------------------------------------------------
// 2. アプリ初期化 (CORSや読み込みエラーに対応した fetch 処理)
// ----------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  // Leaflet 地図インスタンスの初期化
  initMap();

  // GeoJSON データの非同期読み込み (fetch)
  // サブディレクトリデプロイ(GitHub Pages)でも確実に動作するよう、完全な相対パス「./data/」を使用します
  Promise.all([
    fetch('./data/hiroshima_municipalities.geojson').then(res => {
      if (!res.ok) throw new Error("hiroshima_municipalities.geojson の読み込みに失敗しました。");
      return res.json();
    }),
    fetch('./data/hiroshima_wards.geojson').then(res => {
      if (!res.ok) throw new Error("hiroshima_wards.geojson の読み込みに失敗しました。");
      return res.json();
    })
  ]).then(([muniData, wardData]) => {
    muniGeoJsonData = muniData;
    wardGeoJsonData = wardData;

    // localStorageから全データをロード
    loadAllData();
    
    // 初期UI（プルダウン、リスト、地図塗り分け）の描画
    initFormSelect();
    updateUI();
  }).catch(err => {
    console.error("GeoJSON Load Error:", err);
    
    // 画面上に誰でも一目でわかる警告オーバーレイを生成
    showMapError(
      "地図データの読み込みに失敗しました。dataフォルダ内のGeoJSONファイルのパスを確認してください。",
      "【原因の可能性】ローカル環境で index.html を直接ダブルクリックして開いている場合、ブラウザのセキュリティ制限（CORS）によって GeoJSON の fetch が拒否されます。README.md を参考に、簡易Webサーバー（Python / serve 等）を起動してアクセスしてください。"
    );
    
    // データ入力UIの動作を止めないための最低限のフォールバック
    loadAllData();
    initFormSelect();
  });
});

// ----------------------------------------------------
// 3. Leaflet マップ初期化
// ----------------------------------------------------
function initMap() {
  // コンテナID 'map' に地図を生成。無地背景にするためタイルレイヤーはロードしません
  map = L.map('map', {
    zoomControl: true,
    attributionControl: false,
    minZoom: 7,
    maxZoom: 13,
    dragging: true,
    scrollWheelZoom: true
  });

  // 初期位置を広島県の中央付近にセット (GeoJSONロード時に自動的に fitBounds されます)
  map.setView([34.3963, 132.4594], 9);
}

// ----------------------------------------------------
// 4. 入力フォームの動的プルダウン生成
// ----------------------------------------------------
function initFormSelect() {
  const select = document.getElementById('hometown-select');
  const label = document.getElementById('select-label');
  const formTitle = document.getElementById('form-title');
  
  select.innerHTML = '';

  const defaultOption = document.createElement('option');
  defaultOption.value = "";
  defaultOption.disabled = true;
  defaultOption.selected = true;
  defaultOption.hidden = true;

  if (activeMode === 'municipality') {
    label.textContent = "住んでいる市・町";
    formTitle.textContent = "市町村モードで登録";
    defaultOption.textContent = "市・町を選択してください";
    select.appendChild(defaultOption);

    // 市町村リストを順次追加
    REGION_LIST.municipality.forEach(city => {
      const opt = document.createElement('option');
      opt.value = city;
      opt.textContent = city;
      select.appendChild(opt);
    });
  } else {
    label.textContent = "住んでいる区（広島市）";
    formTitle.textContent = "広島市区モードで登録";
    defaultOption.textContent = "区を選択してください";
    select.appendChild(defaultOption);

    // 広島市8区を順次追加
    REGION_LIST.ward.forEach(ward => {
      const opt = document.createElement('option');
      opt.value = ward;
      opt.textContent = ward;
      select.appendChild(opt);
    });
  }
}

// ----------------------------------------------------
// 5. モード切り替え
// ----------------------------------------------------
function switchMode(mode) {
  if (activeMode === mode) return;
  activeMode = mode;

  // タブボタンのアクティブクラス切り替え
  document.getElementById('btn-mode-municipality').classList.toggle('active', mode === 'municipality');
  document.getElementById('btn-mode-ward').classList.toggle('active', mode === 'ward');

  // ポップアップを閉じる
  map.closePopup();

  // フォーム・UIリスト・地図塗り分けの更新
  initFormSelect();
  updateUI();
  
  showToast(`${mode === 'municipality' ? '市町村' : '広島市区'}モードに切り替えました。`, 'success');
}

// ----------------------------------------------------
// 6. コロプレスマップの塗り分け & インタラクション (Leaflet)
// ----------------------------------------------------

// 人数に応じた塗り分けカラーコードを返す (0人:暗いグレー ➔ 1人:薄青 ➔ 2〜3人:中青 ➔ 4人+:濃青)
function getChoroplethColor(count) {
  if (!count || count === 0) {
    return '#1e293b'; // 0人: 暗いグレー
  }
  if (count === 1) {
    return 'rgba(56, 189, 248, 0.45)'; // 1人: 薄い青 (var(--c1-blue-light))
  }
  if (count <= 3) {
    return 'rgba(14, 165, 233, 0.72)'; // 2〜3人: 中くらいの青 (var(--c2-blue-medium))
  }
  return 'rgba(2, 132, 199, 0.95)'; // 4人以上: 濃い青 (var(--c3-blue-dark))
}

// 各フィーチャーのスタイル決定
function getFeatureStyle(feature) {
  const regionName = feature.properties.name;
  const currentData = appData[activeMode];
  const names = currentData[regionName] || [];
  const count = names.length;

  return {
    fillColor: getChoroplethColor(count),
    weight: 2,
    opacity: 1,
    color: '#0f172a', // 境界線は深いスレートネイビー
    fillOpacity: 0.85
  };
}

// 各フィーチャー（ポリゴン）へのインタラクションバインド
function onEachFeature(feature, layer) {
  const regionName = feature.properties.name;

  // A. ホバーツールチップによる地域名表示 (恒常表示ではなく、ホバー時にすっきり出す)
  layer.bindTooltip(regionName, {
    permanent: false,
    direction: 'center',
    className: 'leaflet-tooltip-own'
  });

  layer.on({
    // B. ホバー開始：境界線の黄色ハイライト＆左側リストとの強調連動
    mouseover: (e) => {
      const targetLayer = e.target;
      targetLayer.setStyle({
        color: '#facc15', // イエローで境界線をハイライト
        weight: 3.5,
        fillOpacity: 0.95
      });

      if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) {
        targetLayer.bringToFront();
      }

      // 左側リストのハイライト連動
      const listItem = document.getElementById(`item-${regionName}`);
      if (listItem) {
        listItem.classList.add('highlight-active');
      }
    },

    // C. ホバー終了：ハイライト解除
    mouseout: (e) => {
      if (geojsonLayer) {
        geojsonLayer.resetStyle(e.target);
      }
      
      // 左側リストのハイライト解除
      const listItem = document.getElementById(`item-${regionName}`);
      if (listItem) {
        listItem.classList.remove('highlight-active');
      }
    },

    // D. クリック：指定形式に完全に準拠した Leaflet ポップアップの表示
    click: (e) => {
      const currentData = appData[activeMode];
      const names = currentData[regionName] || [];
      const count = names.length;

      // ユーザー指定の表示形式に完全準拠した HTML
      let popupHTML = `
        <div class="popup-content" style="color: #f8fafc; font-family: 'Noto Sans JP', sans-serif;">
          <h3 style="margin: 0 0 0.5rem 0; font-size: 0.95rem; font-weight: 700; color: #facc15; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 0.25rem;">
            ${regionName}
          </h3>
          <div style="font-size: 0.8rem; font-weight: bold; margin-bottom: 0.4rem; color: #94a3b8;">
            登録人数：${count}人
          </div>
      `;

      if (count > 0) {
        popupHTML += `
          <div style="font-size: 0.75rem; color: #94a3b8; margin-bottom: 0.25rem;">登録者：</div>
          <ol style="margin: 0; padding-left: 1.15rem; font-size: 0.8rem; max-height: 120px; overflow-y: auto; color: #f8fafc;">
            ${names.map(name => `<li>${escapeHtml(name)}</li>`).join('')}
          </ol>
        `;
      } else {
        popupHTML += `<p style="margin: 0; font-size: 0.75rem; color: #94a3b8; text-align: center; padding: 0.3rem 0;">登録データはありません。</p>`;
      }
      popupHTML += `</div>`;

      layer.bindPopup(popupHTML, {
        closeButton: false,
        offset: L.point(0, -5)
      }).openPopup();

      // 左側アコーディオンリストの連動展開＆スクロール
      if (count > 0) {
        toggleAccordion(regionName, true);
        setTimeout(() => {
          const listItem = document.getElementById(`item-${regionName}`);
          if (listItem) {
            listItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }, 150);
      }
    }
  });
}

// 地図レイヤーの描画・更新
function updateMapVisuals() {
  if (!map) return;

  // すでにレイヤーが展開されている場合は削除
  if (geojsonLayer) {
    map.removeLayer(geojsonLayer);
  }

  const geoData = activeMode === 'municipality' ? muniGeoJsonData : wardGeoJsonData;
  if (!geoData) return;

  // GeoJSON レイヤーをマップに追加
  geojsonLayer = L.geoJSON(geoData, {
    style: getFeatureStyle,
    onEachFeature: onEachFeature
  }).addTo(map);

  // 地図の表示範囲（境界）を、行政区域全体にピッタリとフィットさせる (fitBounds)
  try {
    map.fitBounds(geojsonLayer.getBounds(), {
      padding: [30, 30] // 画面端に適度な余白を設定
    });
  } catch (e) {
    console.error("fitBounds failed:", e);
  }
}

// 左側リストホバー連動用：リスト上のホバーで対応する Leaflet ポリゴンをハイライト
function highlightMapRegion(regionName, active) {
  if (!geojsonLayer) return;

  geojsonLayer.eachLayer(layer => {
    if (layer.feature.properties.name === regionName) {
      if (active) {
        layer.setStyle({
          color: '#facc15',
          weight: 3.5,
          fillOpacity: 0.95
        });
        if (!L.Browser.ie && !L.Browser.opera) {
          layer.bringToFront();
        }
      } else {
        geojsonLayer.resetStyle(layer);
      }
    }
  });
}

// ----------------------------------------------------
// 7. データ操作 (CRUD)
// ----------------------------------------------------

// 新規メンバー登録
function handleAddUser() {
  const nameInput = document.getElementById('username');
  const select = document.getElementById('hometown-select');

  const name = nameInput.value.trim();
  const region = select.value;

  if (!name) {
    showToast('お名前を入力してください。', 'error');
    return;
  }
  if (!region) {
    showToast('地域を選択してください。', 'error');
    return;
  }

  // アクティブなモードのデータに格納
  if (!appData[activeMode][region]) {
    appData[activeMode][region] = [];
  }
  appData[activeMode][region].push(name);

  // 保存とUI・地図更新
  saveCurrentData();
  updateUI();
  showToast(`${name}さんを「${region}」に登録しました！`, 'success');

  // お名前入力欄のみクリアしフォーカス
  nameInput.value = '';
  nameInput.focus();

  // 登録した地域を自動的にハイライト＆フォーカス表示
  setTimeout(() => {
    focusOnMapRegion(region);
  }, 400);
}

// 個別名前削除
function deleteUser(region, index) {
  const currentData = appData[activeMode];
  if (!currentData[region]) return;

  const deletedName = currentData[region][index];
  currentData[region].splice(index, 1);

  // 地域に誰もいなくなったらキーを消去
  if (currentData[region].length === 0) {
    delete currentData[region];
  }

  saveCurrentData();
  updateUI();
  showToast(`${deletedName}さんのデータを削除しました。`, 'success');
  map.closePopup();
}

// 全データクリア
function confirmClearAll() {
  const currentData = appData[activeMode];
  const total = Object.values(currentData).reduce((sum, names) => sum + names.length, 0);

  if (total === 0) {
    showToast('削除するデータがありません。', 'error');
    return;
  }

  const modeLabel = activeMode === 'municipality' ? '市町村モード' : '広島市区モード';
  if (confirm(`【警告】現在の${modeLabel}の全データ（${total}名分）を完全に削除します。よろしいですか？\n※他方のモードのデータは消去されません。`)) {
    appData[activeMode] = {};
    saveCurrentData();
    updateUI();
    showToast('すべての登録データをクリアしました。', 'success');
    map.closePopup();
  }
}

// ----------------------------------------------------
// 8. localStorage 連携 & 将来的な共有データベース化について
// ----------------------------------------------------

/* 
  【💡 開発者へのメッセージ：複数ユーザーでのデータ共有に向けて】
  現在は、全登録データが各ユーザー個人のブラウザ（localStorage）にのみ保存されます。
  そのため、Aさんが登録した内容がBさんの画面には共有されません。

  将来的に「全員の登録データをリアルタイムに1つの地図に集計して共有したい」場合は、
  以下の手順でバックエンドのデータベースと連携してください：
  
  1. 保存処理（saveCurrentData）の書き換え：
     - localStorage.setItem の代わりに、Firebase Realtime Database / Supabase / Google Sheets API などの
       エンドポイントに非同期POSTリクエストを送信し、クラウド上にデータを永続保存します。
       例：
       async function saveCurrentDataOnline(region, username) {
         await fetch('https://YOUR_BACKEND_API/register', {
           method: 'POST',
           body: JSON.stringify({ mode: activeMode, region: region, name: username })
         });
       }

  2. 読み込み処理（loadAllData / updateUI）の書き換え：
     - アプリ起動時に、クラウド上のAPIエンドポイントから登録データ一覧をGETリクエストで取得し、
       `appData` を動的に構築してから `updateUI()` を実行します。
       例：
       async function loadAllDataOnline() {
         const res = await fetch('https://YOUR_BACKEND_API/data');
         appData = await res.json();
         updateUI();
       }
*/

function saveCurrentData() {
  localStorage.setItem('hiroshima_geojson_app_data', JSON.stringify(appData));
}

// 独立した localStorage からデータをロード
function loadAllData() {
  const stored = localStorage.getItem('hiroshima_geojson_app_data');

  if (stored) {
    try {
      appData = JSON.parse(stored);
      if (!appData.municipality) appData.municipality = {};
      if (!appData.ward) appData.ward = {};
    } catch (e) {
      console.error(e);
      appData = { municipality: {}, ward: {} };
    }
  } else {
    // デモ用初期データ
    appData = {
      municipality: {
        "福山市": ["山田太郎", "佐藤花子"],
        "呉市": ["鈴木一郎"],
        "東広島市": ["藤川幸二"],
        "三次市": ["永川勝浩"],
        "廿日市市": ["中島浩平"]
      },
      ward: {
        "中区": ["田中花子"],
        "安佐南区": ["高橋太郎"]
      }
    };
    saveCurrentData();
  }
}

// ----------------------------------------------------
// 9. 左側UIリストの更新 (人数の多い順ソート、アコーディオン機能)
// ----------------------------------------------------
function updateUI() {
  const currentData = appData[activeMode];
  
  // 総登録者数の算出と表示
  const total = Object.values(currentData).reduce((sum, names) => sum + names.length, 0);
  document.getElementById('total-count').textContent = total;

  const listContainer = document.getElementById('list-container');

  if (total === 0) {
    listContainer.innerHTML = `
      <div class="empty-state">
        <i class="fa-regular fa-map empty-icon"></i>
        <span>登録データはありません。上のフォームから登録してみましょう！</span>
      </div>
    `;
    updateMapVisuals(); 
    return;
  }

  // 人数順（降順）にソート
  const sortedList = Object.entries(currentData)
    .map(([place, names]) => ({ place, names, count: names.length }))
    .sort((a, b) => b.count - a.count);

  let listHTML = '<ul class="location-list">';

  sortedList.forEach(({ place, names, count }) => {
    listHTML += `
      <li class="location-item" id="item-${escapeHtml(place)}" 
          onmouseover="highlightMapRegion('${escapeHtml(place)}', true)" 
          onmouseout="highlightMapRegion('${escapeHtml(place)}', false)">
        <div class="location-header" onclick="toggleAccordion('${escapeHtml(place)}')">
          <div class="location-name-group">
            <span style="font-weight: 700; font-size: 0.9rem;">${escapeHtml(place)}</span>
            <span class="location-count-badge" style="margin-left: 0.5rem;">${count}人</span>
          </div>
          <div>
            <i class="fa-solid fa-chevron-down chevron-icon"></i>
          </div>
        </div>
        <div class="names-collapse">
          <ul class="names-list">
            ${names.map((name, idx) => `
              <li class="name-item">
                <span class="name-label">
                  <span class="name-number">${idx + 1}.</span>
                  <span>${escapeHtml(name)}</span>
                </span>
                <button class="delete-btn" onclick="event.stopPropagation(); deleteUser('${escapeHtml(place)}', ${idx})" title="この登録を削除">
                  <i class="fa-solid fa-xmark"></i>
                </button>
              </li>
            `).join('')}
            <li style="padding-top: 0.25rem;">
              <button class="btn btn-secondary" style="padding: 0.35rem 0.65rem; font-size: 0.75rem;" onclick="event.stopPropagation(); focusOnMapRegion('${escapeHtml(place)}')">
                <i class="fa-solid fa-eye"></i> マップで表示
              </button>
            </li>
          </ul>
        </div>
      </li>
    `;
  });

  listHTML += '</ul>';
  listContainer.innerHTML = listHTML;

  // 地図の塗り分けとラベル表示の更新
  updateMapVisuals();
}

// リストのアコーディオン開閉
function toggleAccordion(place, forceOpen = false) {
  const item = document.getElementById(`item-${place}`);
  if (!item) return;

  const isActive = item.classList.contains('active');
  
  document.querySelectorAll('.location-item').forEach(el => {
    el.classList.remove('active');
  });

  if (forceOpen || !isActive) {
    item.classList.add('active');
  }
}

// リストの「マップで表示」を押した際、該当ポリゴンをフォーカスズームしポップアップを自動起動
function focusOnMapRegion(place) {
  if (!geojsonLayer) return;

  geojsonLayer.eachLayer(layer => {
    if (layer.feature.properties.name === place) {
      // ズーム・表示移動
      map.setView(layer.getBounds().getCenter(), activeMode === 'municipality' ? 10 : 12);
      
      // ポップアップを開く
      layer.fire('click');
    }
  });

  // スマホの場合はマップへ自動スクロール
  if (window.innerWidth <= 768) {
    const mapArea = document.querySelector('.map-area');
    if (mapArea) {
      mapArea.scrollIntoView({ behavior: 'smooth' });
    }
  }
}

// ----------------------------------------------------
// 10. CSVエクスポート機能 (BOM付き)
// ----------------------------------------------------
function exportToCSV() {
  const currentData = appData[activeMode];
  const total = Object.values(currentData).reduce((sum, names) => sum + names.length, 0);

  if (total === 0) {
    showToast('出力するデータがありません。', 'error');
    return;
  }

  let csvContent = 'お名前,登録地域\n';

  Object.entries(currentData).forEach(([place, names]) => {
    names.forEach(name => {
      const safeName = `"${name.replace(/"/g, '""')}"`;
      const safePlace = `"${place.replace(/"/g, '""')}"`;
      csvContent += `${safeName},${safePlace}\n`;
    });
  });

  const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
  const blob = new Blob([bom, csvContent], { type: 'text/csv;charset=utf-8;' });
  
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const modeLabel = activeMode === 'municipality' ? 'municipality' : 'ward';
  
  link.setAttribute('href', url);
  link.setAttribute('download', `hiroshima_geojson_${modeLabel}_${dateStr}.csv`);
  link.style.visibility = 'hidden';
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  showToast('CSVファイルをエクスポートしました。', 'success');
}

// ----------------------------------------------------
// 11. ユーティリティ & トースト
// ----------------------------------------------------

// HTMLエスケープ
function escapeHtml(string) {
  if (typeof string !== 'string') return string;
  return string.replace(/[&<>"']/g, function(match) {
    const escapeMap = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#x27;'
    };
    return escapeMap[match];
  });
}

// トースト通知
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  const toastIcon = document.getElementById('toast-icon');
  const toastMessage = document.getElementById('toast-message');

  toastMessage.textContent = message;

  toast.className = 'toast'; 
  if (type === 'success') {
    toast.classList.add('show', 'toast-success');
    toastIcon.className = 'fa-solid fa-circle-check';
    toastIcon.style.color = 'var(--success)';
  } else if (type === 'error') {
    toast.classList.add('show', 'toast-danger');
    toastIcon.className = 'fa-solid fa-circle-xmark';
    toastIcon.style.color = 'var(--danger)';
  }

  setTimeout(() => {
    toast.classList.remove('show');
  }, 3500);
}

// 画面上の地図表示エリアにエラーメッセージを表示する (CORSや読み込みミス対策)
function showMapError(message, submessage) {
  const mapArea = document.querySelector('.map-area');
  if (!mapArea) return;

  // 既存のマップエラーがあれば削除
  const existingError = mapArea.querySelector('.map-error-overlay');
  if (existingError) {
    existingError.remove();
  }

  // エラーオーバーレイ要素を動的生成
  const errorOverlay = document.createElement('div');
  errorOverlay.className = 'map-error-overlay';
  errorOverlay.innerHTML = `
    <i class="fa-solid fa-triangle-exclamation map-error-icon"></i>
    <div class="map-error-text">${escapeHtml(message)}</div>
    <div class="map-error-subtext">${escapeHtml(submessage)}</div>
  `;

  mapArea.appendChild(errorOverlay);
}
