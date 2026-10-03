from django.contrib import admin
from django.contrib.auth.admin import UserAdmin

from .models import Client, User


@admin.register(Client)
class ClientAdmin(admin.ModelAdmin):
    list_display = ("name", "city", "state", "phone", "is_active", "created_at")
    list_filter = ("is_active",)
    search_fields = ("name", "city")


@admin.register(User)
class MotelUserAdmin(UserAdmin):
    list_display = ("username", "first_name", "last_name", "role", "client", "is_active")
    list_filter = ("role", "client", "is_active")
    fieldsets = UserAdmin.fieldsets + (("MotelMitra", {"fields": ("role", "client", "phone")}),)
