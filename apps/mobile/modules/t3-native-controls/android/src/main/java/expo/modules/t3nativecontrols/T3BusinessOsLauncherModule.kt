package expo.modules.t3nativecontrols

import android.content.Context
import android.graphics.Color as AndroidColor
import android.view.ViewGroup.LayoutParams
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.roundToInt
import org.json.JSONObject

private data class LauncherApp(
  val id: String,
  val title: String,
  val accent: Color,
  val iconAssetId: String,
  val iconFamilyVersion: Int,
  val iconRequired: Boolean,
  val desktopOnly: Boolean,
)

private data class LauncherItem(
  val kind: String,
  val id: String,
  val appId: String?,
  val title: String?,
  val appIds: List<String>,
)

private class LauncherState {
  var apps by mutableStateOf<List<LauncherApp>>(emptyList())
  var pages by mutableStateOf<List<List<LauncherItem>>>(listOf(emptyList()))
  var dock by mutableStateOf<List<String>>(emptyList())
  var badges by mutableStateOf<Map<String, Int>>(emptyMap())
  var instanceName by mutableStateOf("Business OS")
  var editing by mutableStateOf(false)
}

class T3BusinessOsLauncherView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onOpenApp by EventDispatcher()
  private val onOpenSearch by EventDispatcher()
  private val onOpenRecents by EventDispatcher()
  private val onOpenSettings by EventDispatcher()
  private val onReturnToCode by EventDispatcher()
  private val onLayoutChange by EventDispatcher()
  private val state = LauncherState()
  private val composeView = ComposeView(context).apply {
    setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
    setContent {
      WorkjetOneUiLauncher(
        state = state,
        onOpenApp = { appId -> if (appId != "desktop") onOpenApp(mapOf("appId" to appId)) },
        onOpenSearch = { onOpenSearch(emptyMap<String, Any>()) },
        onOpenRecents = { onOpenRecents(emptyMap<String, Any>()) },
        onOpenSettings = { onOpenSettings(emptyMap<String, Any>()) },
        onReturnToCode = { onReturnToCode(emptyMap<String, Any>()) },
        onLayoutChange = { page, source, target ->
          onLayoutChange(mapOf("pageIndex" to page, "sourceIndex" to source, "targetIndex" to target))
        },
      )
    }
  }

  init {
    addView(composeView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  fun setCatalogJson(raw: String) {
    if (raw.toByteArray().size > 262_144) return
    try {
      val apps = JSONObject(raw).optJSONArray("apps") ?: return
      if (apps.length() > 256) return
      val allowedKeys = setOf(
        "id", "title", "category", "iconAssetId", "iconFamilyVersion", "iconRequired", "accent",
        "mobilePresentation", "phoneReady", "tabletReady", "desktopOnly",
      )
      val nextApps = buildList {
        for (index in 0 until apps.length()) {
          val app = apps.optJSONObject(index) ?: return
          if (app.keys().asSequence().any { it !in allowedKeys }) return
          val id = app.optString("id")
          val title = app.optString("title")
          val iconAssetId = app.optString("iconAssetId")
          if (
            !id.matches(Regex("[a-z0-9][a-z0-9._-]{0,127}")) || id == "desktop" ||
            !iconAssetId.matches(Regex("[a-z0-9][a-z0-9._-]{0,127}")) ||
            app.optInt("iconFamilyVersion") != 1 || !app.has("iconRequired") ||
            title.isBlank() || title.length > 80
          ) return
          add(
            LauncherApp(
              id = id,
              title = title.take(80),
              accent = parseColor(app.optString("accent")),
              iconAssetId = iconAssetId,
              iconFamilyVersion = 1,
              iconRequired = app.optBoolean("iconRequired"),
              desktopOnly = app.optBoolean("desktopOnly", false),
            ),
          )
        }
      }
      state.apps = nextApps
    } catch (_: Exception) {
      return
    }
  }

  fun setLayoutJson(raw: String) {
    if (raw.toByteArray().size > 262_144) return
    try {
      val value = JSONObject(raw)
      val rawPages = value.optJSONArray("pages") ?: return
      val pages = buildList {
        for (pageIndex in 0 until rawPages.length()) {
          val rawPage = rawPages.optJSONArray(pageIndex) ?: continue
          add(buildList {
            for (itemIndex in 0 until rawPage.length()) {
              val item = rawPage.optJSONObject(itemIndex) ?: continue
              val appIds = item.optJSONArray("appIds")
              add(
                LauncherItem(
                  kind = item.optString("kind"),
                  id = item.optString("id"),
                  appId = item.optString("appId").takeIf { it.isNotBlank() && it != "desktop" },
                  title = item.optString("title").takeIf(String::isNotBlank)?.take(48),
                  appIds = buildList {
                    if (appIds != null) for (index in 0 until appIds.length()) {
                      appIds.optString(index).takeIf { it.isNotBlank() && it != "desktop" }?.let(::add)
                    }
                  },
                ),
              )
            }
          })
        }
      }
      state.pages = pages.ifEmpty { listOf(emptyList()) }
      val rawDock = value.optJSONArray("dock")
      state.dock = buildList {
        if (rawDock != null) for (index in 0 until rawDock.length()) {
          rawDock.optString(index).takeIf { it.isNotBlank() && it != "desktop" }?.let(::add)
        }
      }
    } catch (_: Exception) {
      return
    }
  }

  fun setBadgesJson(raw: String) {
    if (raw.toByteArray().size > 16_384) return
    try {
      val value = JSONObject(raw)
      state.badges = value.keys().asSequence().mapNotNull { id ->
        value.optInt(id).takeIf { id != "desktop" && it in 1..999 }?.let { id to it }
      }.toMap()
    } catch (_: Exception) {
      return
    }
  }

  fun setInstanceName(value: String) {
    state.instanceName = value.trim().take(80).ifEmpty { "Business OS" }
  }
}

class T3BusinessOsLauncherModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3BusinessOsLauncher")
    View(T3BusinessOsLauncherView::class) {
      Prop("catalogJson") { view: T3BusinessOsLauncherView, value: String -> view.setCatalogJson(value) }
      Prop("layoutJson") { view: T3BusinessOsLauncherView, value: String -> view.setLayoutJson(value) }
      Prop("badgesJson") { view: T3BusinessOsLauncherView, value: String -> view.setBadgesJson(value) }
      Prop("instanceName") { view: T3BusinessOsLauncherView, value: String -> view.setInstanceName(value) }
      Events("onOpenApp", "onOpenSearch", "onOpenRecents", "onOpenSettings", "onReturnToCode", "onLayoutChange")
    }
    Function("isSupported") { true }
  }
}

@OptIn(ExperimentalFoundationApi::class, ExperimentalMaterial3Api::class)
@Composable
private fun WorkjetOneUiLauncher(
  state: LauncherState,
  onOpenApp: (String) -> Unit,
  onOpenSearch: () -> Unit,
  onOpenRecents: () -> Unit,
  onOpenSettings: () -> Unit,
  onReturnToCode: () -> Unit,
  onLayoutChange: (Int, Int, Int) -> Unit,
) {
  val context = LocalContext.current
  val dark = (context.resources.configuration.uiMode and 0x30) == 0x20
  MaterialTheme(colorScheme = if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)) {
    BoxWithConstraints(
      modifier = Modifier
        .fillMaxSize()
        .background(
          Brush.verticalGradient(
            listOf(
              MaterialTheme.colorScheme.surface,
              MaterialTheme.colorScheme.surfaceContainerLowest,
            ),
          ),
        ),
    ) {
      val landscape = maxWidth > maxHeight
      val columns = when {
        maxWidth >= 840.dp -> if (landscape) 8 else 6
        maxWidth >= 600.dp -> if (landscape) 7 else 5
        else -> if (landscape) 6 else 4
      }
      val roomyGrid = maxWidth >= 600.dp
      var upwardDrag by remember { mutableStateOf(0f) }
      Column(
        modifier = Modifier
          .fillMaxSize()
          .pointerInput(Unit) {
            detectVerticalDragGestures(
              onVerticalDrag = { change, amount -> change.consume(); upwardDrag += amount },
              onDragEnd = { if (upwardDrag < -90f) onOpenSearch(); upwardDrag = 0f },
              onDragCancel = { upwardDrag = 0f },
            )
          },
      ) {
        OneUiExtendedHeader(state, onReturnToCode, onOpenSearch, onOpenSettings)
        val pagerState = rememberPagerState(pageCount = { state.pages.size })
        HorizontalPager(state = pagerState, modifier = Modifier.weight(1f)) { pageIndex ->
          val page = state.pages.getOrElse(pageIndex) { emptyList() }
          LazyVerticalGrid(
            columns = GridCells.Fixed(columns),
            verticalArrangement = Arrangement.spacedBy(if (roomyGrid) 22.dp else 16.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier.fillMaxSize().padding(horizontal = 14.dp, vertical = 18.dp),
          ) {
            itemsIndexed(page, key = { _, item -> item.id }) { itemIndex, item ->
              val apps = state.apps.associateBy { it.id }
              if (item.kind == "folder") {
                OneUiFolderCell(item, apps)
              } else {
                item.appId?.let(apps::get)?.let { app ->
                  OneUiAppCell(
                    app = app,
                    badge = state.badges[app.id],
                    editing = state.editing,
                    columns = columns,
                    itemIndex = itemIndex,
                    onOpen = { if (!app.desktopOnly) onOpenApp(app.id) },
                    onEdit = { state.editing = true },
                    onMove = { target -> onLayoutChange(pageIndex, itemIndex, target.coerceIn(page.indices)) },
                  )
                }
              }
            }
          }
        }
        Row(
          horizontalArrangement = Arrangement.spacedBy(6.dp),
          modifier = Modifier.align(Alignment.CenterHorizontally).height(22.dp),
        ) {
          repeat(state.pages.size) { index ->
            val active = index == pagerState.currentPage
            Box(
              Modifier
                .size(width = if (active) 16.dp else 6.dp, height = 6.dp)
                .clip(CircleShape)
                .background(if (active) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.35f)),
            )
          }
        }
        OneUiDock(state, onOpenApp, onOpenRecents)
      }
    }
  }
}

@Composable
private fun OneUiExtendedHeader(
  state: LauncherState,
  onReturnToCode: () -> Unit,
  onOpenSearch: () -> Unit,
  onOpenSettings: () -> Unit,
) {
  Column(Modifier.fillMaxWidth().height(132.dp).padding(horizontal = 18.dp, vertical = 10.dp)) {
    Spacer(Modifier.weight(1f))
    Row(verticalAlignment = Alignment.CenterVertically) {
      IconButton(onClick = onReturnToCode, modifier = Modifier.size(48.dp)) {
        Icon(painterResource(android.R.drawable.ic_media_previous), contentDescription = "In Code wechseln")
      }
      Column(Modifier.weight(1f)) {
        Text(state.instanceName, fontSize = 28.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(if (state.editing) "Apps bewegen oder zusammenlegen" else "Business OS", color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
      if (state.editing) {
        Button(onClick = { state.editing = false }, contentPadding = ButtonDefaults.ContentPadding) { Text("Fertig") }
      } else {
        IconButton(onClick = onOpenSearch, modifier = Modifier.size(48.dp)) {
          Icon(painterResource(android.R.drawable.ic_menu_search), contentDescription = "Apps durchsuchen")
        }
        IconButton(onClick = onOpenSettings, modifier = Modifier.size(48.dp)) {
          Icon(painterResource(android.R.drawable.ic_menu_preferences), contentDescription = "Business OS Einstellungen")
        }
      }
    }
  }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun OneUiAppCell(
  app: LauncherApp,
  badge: Int?,
  editing: Boolean,
  columns: Int,
  itemIndex: Int,
  compact: Boolean = false,
  onOpen: () -> Unit,
  onEdit: () -> Unit,
  onMove: (Int) -> Unit = {},
) {
  val haptic = LocalHapticFeedback.current
  val density = LocalDensity.current
  var drag by remember(app.id) { mutableStateOf(Offset.Zero) }
  val scale by animateFloatAsState(if (editing) 0.97f else 1f, label = "edit-scale")
  Column(
    horizontalAlignment = Alignment.CenterHorizontally,
    modifier = Modifier
      .fillMaxWidth()
      .scale(scale)
      .rotate(if (editing) -0.7f else 0f)
      .offset { IntOffset(drag.x.roundToInt(), drag.y.roundToInt()) }
      .semantics { contentDescription = app.title }
      .combinedClickable(onClick = onOpen, onLongClick = {
        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
        onEdit()
      })
      .pointerInput(editing, app.id) {
        if (!editing) return@pointerInput
        detectDragGesturesAfterLongPress(
          onDragStart = { haptic.performHapticFeedback(HapticFeedbackType.LongPress) },
          onDrag = { change, amount -> change.consume(); drag += amount },
          onDragEnd = {
            val cell = with(density) { 92.dp.toPx() }
            val row = with(density) { 112.dp.toPx() }
            onMove(itemIndex + (drag.x / cell).roundToInt() + (drag.y / row).roundToInt() * columns)
            drag = Offset.Zero
          },
          onDragCancel = { drag = Offset.Zero },
        )
      },
  ) {
    BadgedBox(
      badge = {
        if (badge != null && badge > 0) Badge { Text(if (badge > 99) "99+" else badge.toString()) }
      },
    ) {
      Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
          .size(if (compact) 52.dp else 60.dp)
          .clip(RoundedCornerShape(if (compact) 15.dp else 18.dp))
          .background(Brush.linearGradient(listOf(app.accent, app.accent.copy(alpha = 0.68f)))),
      ) {
        Text(
          text = app.title.trim().firstOrNull()?.uppercase() ?: "•",
          color = Color.White,
          fontSize = if (compact) 22.sp else 26.sp,
          fontWeight = FontWeight.Bold,
        )
      }
    }
    if (!compact) {
      Text(
        app.title,
        fontSize = 12.sp,
        lineHeight = 14.sp,
        fontWeight = FontWeight.Medium,
        textAlign = TextAlign.Center,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.padding(top = 7.dp).height(30.dp).fillMaxWidth(),
      )
    }
  }
}

@Composable
private fun OneUiFolderCell(item: LauncherItem, apps: Map<String, LauncherApp>) {
  Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
    Surface(shape = RoundedCornerShape(18.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.size(60.dp)) {
      LazyVerticalGrid(
        columns = GridCells.Fixed(2),
        userScrollEnabled = false,
        verticalArrangement = Arrangement.spacedBy(4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        modifier = Modifier.padding(9.dp),
      ) {
        items(item.appIds.take(4).size) { index ->
          Box(Modifier.size(17.dp).clip(RoundedCornerShape(5.dp)).background(apps[item.appIds[index]]?.accent ?: Color.Gray))
        }
      }
    }
    Text(item.title ?: "Ordner", fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 7.dp))
  }
}

@Composable
private fun OneUiDock(state: LauncherState, onOpenApp: (String) -> Unit, onOpenRecents: () -> Unit) {
  val apps = state.apps.associateBy { it.id }
  Surface(
    shape = RoundedCornerShape(30.dp),
    color = MaterialTheme.colorScheme.surfaceContainerHigh.copy(alpha = 0.94f),
    tonalElevation = 6.dp,
    shadowElevation = 4.dp,
    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).fillMaxWidth(),
  ) {
    Row(horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
      state.dock.forEach { appId ->
        apps[appId]?.let { app ->
          OneUiAppCell(app, state.badges[appId], false, 1, 0, compact = true, onOpen = { onOpenApp(appId) }, onEdit = {})
        }
      }
      Spacer(Modifier.width(1.dp).height(42.dp).background(MaterialTheme.colorScheme.outlineVariant))
      IconButton(onClick = onOpenRecents, modifier = Modifier.size(52.dp)) {
        Icon(painterResource(android.R.drawable.ic_menu_recent_history), contentDescription = "Workjet Recents")
      }
    }
  }
}

private fun parseColor(raw: String): Color = try {
  Color(AndroidColor.parseColor(raw))
} catch (_: Exception) {
  Color(0xFF64748B)
}
