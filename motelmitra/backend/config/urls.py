from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path
from rest_framework.routers import DefaultRouter
from rest_framework_simplejwt.views import TokenRefreshView

from accounts.views import ClientViewSet, LoginView, UserViewSet, me, motel_settings
from motel import views as mv

router = DefaultRouter()
router.register("clients", ClientViewSet, basename="client")
router.register("users", UserViewSet, basename="user")
router.register("room-types", mv.RoomTypeViewSet, basename="room-type")
router.register("rooms", mv.RoomViewSet, basename="room")
router.register("guests", mv.GuestViewSet, basename="guest")
router.register("stays", mv.StayViewSet, basename="stay")
router.register("notes", mv.NoteViewSet, basename="note")

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/auth/login/", LoginView.as_view()),
    path("api/auth/refresh/", TokenRefreshView.as_view()),
    path("api/auth/me/", me),
    path("api/settings/", motel_settings),
    path("api/dashboard/", mv.dashboard),
    path("api/maintenance/", mv.maintenance_board),
    path("api/reports/today/", mv.report_today),
    path("api/reports/checkins/", mv.report_checkins),
    path("api/reports/collections/", mv.report_collections),
    path("api/reports/outstanding/", mv.report_outstanding),
    path("api/reports/occupancy/", mv.report_occupancy),
    path("api/", include(router.urls)),
] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
